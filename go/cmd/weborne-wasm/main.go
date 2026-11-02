// SPDX-License-Identifier: Apache-2.0 OR GPL-2.0-or-later

//go:build js && wasm

// Command weborne-wasm drives a Sony CECH-ZD1 J (torne) from a web page over
// WebUSB. It reuses coax's MB86H47A and DiB8096 drivers unchanged, reads the
// built-in card slot for the ECM keys, and hands the page a descrambled
// transport stream of one service.
//
// The page sees a global `weborne` object whose methods return promises:
//
//	attach(usb)          bring the board up (usb is web/usb.js's wrapper)
//	tune(hz[, waitMs])   tune and wait for lock; resolves to the status
//	status()             signal and descrambler state
//	start(onData, onServices)  stream; onData gets Uint8Array chunks
//	stop()               stop streaming
//	select(serviceID)    pick the service passed on (0 = automatic)
//	release()            put the demodulator to sleep and the LED to green
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"syscall/js"
	"time"

	"github.com/Till0196/coax/internal/coaxd/demod/dib8096"
	"github.com/Till0196/coax/internal/coaxd/usb/bridge/mb86h47"
	"github.com/Till0196/coax/internal/weborne/pipeline"
	"github.com/Till0196/coax/pkg/iso7816"
	"github.com/Till0196/coax/pkg/usbio"
)

// ledPin is the DiB8096 GPIO wired to the front LED: high is red.
const ledPin = 1

type board struct {
	mu       sync.Mutex
	bridge   *mb86h47.Bridge
	demod    *dib8096.Demod
	card     *iso7816.Session
	cardInfo *pipeline.CardInfo
	cardErr  string

	streamMu  sync.Mutex
	streaming bool
	stopped   chan struct{}
	pipe      *pipeline.Pipeline
	selected  uint16
	bytesIn   uint64
	frequency uint32
}

var current *board

func (b *board) attach(usb js.Value) (any, error) {
	bridge := mb86h47.New(&webUSB{js: usb})
	if err := bridge.Start(); err != nil {
		if strings.Contains(err.Error(), "power-up state") {
			return nil, errors.New("torne に前回の状態が残っています。USB を一度抜いて挿し直してから、もう一度接続してください")
		}
		return nil, fmt.Errorf("MB86H47A の起動に失敗: %w", err)
	}
	if err := bridge.ResetDemodulator(); err != nil {
		return nil, fmt.Errorf("DiB8096 のリセットに失敗: %w", err)
	}
	// As cechzd1j does: confirm the demodulator's I2C address.
	if err := bridge.Write(dib8096.Address, []byte{0x05, 0x07, 0x00, 0x03}); err != nil {
		return nil, fmt.Errorf("DiB8096 の検出に失敗: %w", err)
	}
	demod := dib8096.New(bridge)
	if err := demod.Initialize(); err != nil {
		return nil, fmt.Errorf("DiB8096 の初期化に失敗: %w", err)
	}
	b.bridge, b.demod = bridge, demod
	b.initCard()
	return map[string]any{
		"card":      b.cardInfo != nil,
		"cardError": b.cardErr,
		"cardId":    b.cardID(),
	}, nil
}

func (b *board) cardID() string {
	if b.cardInfo == nil {
		return ""
	}
	return fmt.Sprintf("%012X", b.cardInfo.CardID)
}

func (b *board) initCard() {
	b.card = iso7816.New(b.bridge.CardLine())
	b.cardInfo, b.cardErr = nil, ""
	present, err := b.card.Present()
	if err != nil {
		b.cardErr = "カードスロットを読めません: " + err.Error()
		return
	}
	if !present {
		b.cardErr = "カードが挿さっていません"
		return
	}
	if _, err := b.card.Reset(); err != nil {
		b.cardErr = "カードのリセットに失敗: " + err.Error()
		return
	}
	info, err := pipeline.InitCard(b.card)
	if err != nil {
		b.cardErr = err.Error()
		return
	}
	b.cardInfo = info
}

func (b *board) tune(frequency uint32, wait time.Duration) (any, error) {
	if b.demod == nil {
		return nil, errors.New("torne が接続されていません")
	}
	b.stopStream()
	b.mu.Lock()
	defer b.mu.Unlock()
	if err := b.demod.SetGPIO(ledPin, true); err != nil {
		return nil, err
	}
	b.bridge.PrepareStream()
	if err := b.demod.Tune(frequency); err != nil {
		return nil, err
	}
	b.frequency = frequency
	deadline := time.Now().Add(wait)
	for {
		status, err := b.demod.Status()
		if err != nil {
			return nil, err
		}
		if status.Locked || time.Now().After(deadline) {
			return signal(status), nil
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func signal(status dib8096.Status) map[string]any {
	out := map[string]any{"locked": status.Locked}
	if status.HasCNR {
		out["cnr"] = status.CNR
	}
	if status.HasStrength {
		out["strength"] = status.StrengthDBm
	}
	return out
}

func (b *board) status() (any, error) {
	if b.demod == nil {
		return nil, errors.New("torne が接続されていません")
	}
	b.mu.Lock()
	status, err := b.demod.Status()
	b.mu.Unlock()
	if err != nil {
		return nil, err
	}
	out := signal(status)
	b.streamMu.Lock()
	pipe := b.pipe
	out["bytes"] = float64(b.bytesIn)
	out["streaming"] = b.streaming
	b.streamMu.Unlock()
	if pipe != nil {
		raw, _ := json.Marshal(pipe.Status())
		out["pipeline"] = string(raw)
	}
	out["card"] = b.cardInfo != nil
	out["cardError"] = b.cardErr
	return out, nil
}

func (b *board) start(onData, onServices js.Value) (any, error) {
	if b.demod == nil {
		return nil, errors.New("torne が接続されていません")
	}
	b.stopStream()
	b.mu.Lock()
	if err := b.demod.SetOutputMode(dib8096.OutputParallelGatedClock); err != nil {
		b.mu.Unlock()
		return nil, err
	}
	if err := b.bridge.StartStream(); err != nil {
		b.mu.Unlock()
		return nil, err
	}
	b.mu.Unlock()

	var card pipeline.Card
	if b.cardInfo != nil {
		card = b.card
	}
	pipe := pipeline.New(card, b.cardInfo, func(services []pipeline.Service) {
		raw, _ := json.Marshal(services)
		onServices.Invoke(string(raw))
	})
	pipe.Select(b.selected)

	b.streamMu.Lock()
	b.pipe = pipe
	b.streaming = true
	b.bytesIn = 0
	stopped := make(chan struct{})
	b.stopped = stopped
	b.streamMu.Unlock()

	go func() {
		defer close(stopped)
		defer pipe.Close()
		buffer := make([]byte, 188*512)
		var out []byte
		for {
			b.streamMu.Lock()
			running := b.streaming
			b.streamMu.Unlock()
			if !running {
				return
			}
			n, err := b.bridge.ReadStream(buffer, 300)
			if err != nil && !errors.Is(err, usbio.ErrTimeout) {
				js.Global().Get("console").Call("warn", "weborne: stream read:", err.Error())
				time.Sleep(50 * time.Millisecond)
				continue
			}
			if n == 0 {
				continue
			}
			b.streamMu.Lock()
			b.bytesIn += uint64(n)
			b.streamMu.Unlock()
			out = pipe.Process(buffer[:n], out[:0])
			if len(out) > 0 {
				onData.Invoke(toJS(out))
			}
		}
	}()
	return nil, nil
}

func (b *board) stopStream() {
	b.streamMu.Lock()
	if !b.streaming {
		b.streamMu.Unlock()
		return
	}
	b.streaming = false
	stopped := b.stopped
	b.streamMu.Unlock()
	<-stopped
	b.mu.Lock()
	_ = b.bridge.StopStream()
	_ = b.demod.SetOutputMode(dib8096.OutputHighZ)
	b.mu.Unlock()
	b.streamMu.Lock()
	b.pipe = nil
	b.streamMu.Unlock()
}

func (b *board) selectService(id uint16) {
	b.streamMu.Lock()
	b.selected = id
	pipe := b.pipe
	b.streamMu.Unlock()
	if pipe != nil {
		pipe.Select(id)
	}
}

func (b *board) release() (any, error) {
	if b.demod == nil {
		return nil, nil
	}
	b.stopStream()
	b.mu.Lock()
	defer b.mu.Unlock()
	_ = b.demod.SetGPIO(ledPin, false)
	return nil, b.demod.Sleep()
}

// promise runs fn on its own goroutine and settles a JS promise with what it
// returns.
func promise(fn func() (any, error)) js.Value {
	var executor js.Func
	executor = js.FuncOf(func(_ js.Value, args []js.Value) any {
		resolve, reject := args[0], args[1]
		go func() {
			defer func() {
				if r := recover(); r != nil {
					reject.Invoke(js.Global().Get("Error").New(fmt.Sprint("panic: ", r)))
				}
			}()
			value, err := fn()
			if err != nil {
				reject.Invoke(js.Global().Get("Error").New(err.Error()))
				return
			}
			resolve.Invoke(js.ValueOf(value))
		}()
		return nil
	})
	defer executor.Release()
	return js.Global().Get("Promise").New(executor)
}

func main() {
	api := map[string]any{
		"attach": js.FuncOf(func(_ js.Value, args []js.Value) any {
			return promise(func() (any, error) {
				current = &board{}
				return current.attach(args[0])
			})
		}),
		"tune": js.FuncOf(func(_ js.Value, args []js.Value) any {
			// An optional second argument is how long to wait for lock, in ms.
			wait := 3 * time.Second
			if len(args) > 1 && args[1].Type() == js.TypeNumber {
				wait = time.Duration(args[1].Int()) * time.Millisecond
			}
			return promise(func() (any, error) { return current.tune(uint32(args[0].Float()), wait) })
		}),
		"status": js.FuncOf(func(_ js.Value, args []js.Value) any {
			return promise(func() (any, error) { return current.status() })
		}),
		"start": js.FuncOf(func(_ js.Value, args []js.Value) any {
			return promise(func() (any, error) { return current.start(args[0], args[1]) })
		}),
		"stop": js.FuncOf(func(_ js.Value, args []js.Value) any {
			return promise(func() (any, error) { current.stopStream(); return nil, nil })
		}),
		"select": js.FuncOf(func(_ js.Value, args []js.Value) any {
			current.selectService(uint16(args[0].Int()))
			return nil
		}),
		"release": js.FuncOf(func(_ js.Value, args []js.Value) any {
			return promise(func() (any, error) { return current.release() })
		}),
	}
	object := js.Global().Get("Object").New()
	for name, fn := range api {
		object.Set(name, fn)
	}
	js.Global().Set("weborne", object)
	if ready := js.Global().Get("onWeborneReady"); ready.Type() == js.TypeFunction {
		ready.Invoke()
	}
	select {}
}
