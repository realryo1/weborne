// SPDX-License-Identifier: Apache-2.0 OR GPL-2.0-or-later

//go:build windows

// Command weborne-file runs the weborne pipeline over a recorded transport
// stream on Windows, talking to the card through a winscard.dll, so the
// descrambling can be checked without a browser.
//
//	weborne-file <winscard.dll> <in.ts> <out.ts> [service-id]
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"syscall"
	"time"
	"unsafe"

	"github.com/Till0196/coax/internal/weborne/pipeline"
)

type winscard struct {
	transmit *syscall.Proc
	handle   uintptr
	protocol uint32
}

func openCard(path string) (*winscard, error) {
	dll, err := syscall.LoadDLL(path)
	if err != nil {
		return nil, err
	}
	var ctx uintptr
	if r, _, _ := dll.MustFindProc("SCardEstablishContext").Call(2, 0, 0, uintptr(unsafe.Pointer(&ctx))); r != 0 {
		return nil, fmt.Errorf("SCardEstablishContext %#x", r)
	}
	var size uint32
	list := dll.MustFindProc("SCardListReadersW")
	list.Call(ctx, 0, 0, uintptr(unsafe.Pointer(&size)))
	buffer := make([]uint16, size)
	if r, _, _ := list.Call(ctx, 0, uintptr(unsafe.Pointer(&buffer[0])), uintptr(unsafe.Pointer(&size))); r != 0 {
		return nil, fmt.Errorf("SCardListReadersW %#x", r)
	}
	fmt.Fprintln(os.Stderr, "reader:", syscall.UTF16ToString(buffer))
	card := &winscard{transmit: dll.MustFindProc("SCardTransmit")}
	if r, _, _ := dll.MustFindProc("SCardConnectW").Call(ctx, uintptr(unsafe.Pointer(&buffer[0])), 2, 3,
		uintptr(unsafe.Pointer(&card.handle)), uintptr(unsafe.Pointer(&card.protocol))); r != 0 {
		return nil, fmt.Errorf("SCardConnectW %#x", r)
	}
	return card, nil
}

func (card *winscard) Transmit(apdu []byte) ([]byte, error) {
	pci := [2]uint32{card.protocol, 8}
	answer := make([]byte, 258)
	length := uint32(len(answer))
	r, _, _ := card.transmit.Call(card.handle, uintptr(unsafe.Pointer(&pci)), uintptr(unsafe.Pointer(&apdu[0])), uintptr(len(apdu)),
		0, uintptr(unsafe.Pointer(&answer[0])), uintptr(unsafe.Pointer(&length)))
	if r != 0 {
		return nil, fmt.Errorf("SCardTransmit %#x", r)
	}
	return answer[:length], nil
}

func main() {
	if len(os.Args) < 4 {
		fmt.Fprintln(os.Stderr, "usage: weborne-file <winscard.dll> <in.ts> <out.ts> [service-id]")
		os.Exit(2)
	}
	card, err := openCard(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	info, err := pipeline.InitCard(card)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stderr, "card: CA system %#04x\n", info.CASystemID)
	data, err := os.ReadFile(os.Args[2])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	p := pipeline.New(card, info, func(services []pipeline.Service) {
		b, _ := json.Marshal(services)
		fmt.Fprintln(os.Stderr, "services:", string(b))
	})
	if len(os.Args) > 4 {
		id, _ := strconv.Atoi(os.Args[4])
		p.Select(uint16(id))
	}
	var out []byte
	// Feed in chunks as the stream would arrive, letting the card catch up
	// as it would in real time.
	const chunk = 188 * 16
	for offset := 0; offset < len(data); offset += chunk {
		end := min(offset+chunk, len(data))
		out = p.Process(data[offset:end], out)
		// Let the card catch up, as it would when the stream arrives in
		// real time.
		for wait := 0; wait < 300 && p.PendingECMs() > 0; wait++ {
			time.Sleep(10 * time.Millisecond)
		}
	}
	b, _ := json.Marshal(p.Status())
	fmt.Fprintln(os.Stderr, "status:", string(b))
	if err := os.WriteFile(os.Args[3], out, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
