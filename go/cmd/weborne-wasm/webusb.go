// SPDX-License-Identifier: Apache-2.0 OR GPL-2.0-or-later

//go:build js && wasm

package main

import (
	"errors"
	"syscall/js"

	"github.com/Till0196/coax/pkg/usbio"
)

// webUSB is the mb86h47.Device the bridge drives, carried by the page's
// WebUSB wrapper (web/usb.js). Every call waits on a JS promise, so it must
// run on a goroutine of its own, never inside a JS callback.
type webUSB struct {
	js js.Value
}

// await blocks the calling goroutine until a promise settles.
func await(promise js.Value) (js.Value, error) {
	done := make(chan struct{})
	var value js.Value
	var err error
	then := js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) > 0 {
			value = args[0]
		}
		close(done)
		return nil
	})
	catch := js.FuncOf(func(_ js.Value, args []js.Value) any {
		message := "unknown error"
		if len(args) > 0 {
			message = args[0].Call("toString").String()
		}
		err = errors.New(message)
		close(done)
		return nil
	})
	promise.Call("then", then, catch)
	<-done
	then.Release()
	catch.Release()
	return value, err
}

func toJS(data []byte) js.Value {
	array := js.Global().Get("Uint8Array").New(len(data))
	js.CopyBytesToJS(array, data)
	return array
}

// Control runs a transfer on the default pipe. The WebUSB wrapper resolves to
// the bytes read for an IN transfer and to the count written for an OUT one.
func (device *webUSB) Control(requestType, request byte, value, index uint16, buffer []byte, timeoutMS uint32) (int, error) {
	if requestType&0x80 != 0 {
		result, err := await(device.js.Call("controlIn", requestType, request, value, index, len(buffer)))
		if err != nil {
			return 0, err
		}
		return js.CopyBytesToGo(buffer, result), nil
	}
	result, err := await(device.js.Call("controlOut", requestType, request, value, index, toJS(buffer)))
	if err != nil {
		return 0, err
	}
	return result.Int(), nil
}

// Bulk runs a bulk transfer. IN endpoints are read from the wrapper's queue,
// which keeps transfers outstanding so that nothing the device sends while
// the bridge is busy elsewhere is lost; an empty queue past the timeout is
// usbio.ErrTimeout, as the bridge expects.
func (device *webUSB) Bulk(endpoint byte, buffer []byte, timeoutMS uint32) (int, error) {
	if endpoint&0x80 != 0 {
		result, err := await(device.js.Call("bulkIn", endpoint, len(buffer), timeoutMS))
		if err != nil {
			return 0, err
		}
		if result.IsNull() || result.IsUndefined() {
			return 0, usbio.ErrTimeout
		}
		return js.CopyBytesToGo(buffer, result), nil
	}
	result, err := await(device.js.Call("bulkOut", endpoint, toJS(buffer)))
	if err != nil {
		return 0, err
	}
	return result.Int(), nil
}
