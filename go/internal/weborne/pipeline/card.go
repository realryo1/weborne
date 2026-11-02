// SPDX-License-Identifier: Apache-2.0 OR GPL-2.0-or-later

package pipeline

import (
	"encoding/binary"
	"errors"
	"fmt"

	"github.com/Till0196/coax/internal/weborne/multi2"
)

// Card is anything that carries one command APDU to the CAS card and brings
// its answer back, status bytes included.
type Card interface {
	Transmit(apdu []byte) ([]byte, error)
}

// CardInfo is what the card's Initial Setting Conditions command reports.
type CardInfo struct {
	CASystemID uint16
	CardID     uint64
	SystemKey  multi2.SystemKey
	InitialCBC [8]byte
}

// Commands of ARIB STD-B25 part 1 that a receiver needs.
var (
	commandInitialSetting = []byte{0x90, 0x30, 0x00, 0x00, 0x00}
	commandECMHeader      = []byte{0x90, 0x34, 0x00, 0x00}
)

// InitCard asks the card for its system key and CBC initial value.
func InitCard(card Card) (*CardInfo, error) {
	answer, err := card.Transmit(commandInitialSetting)
	if err != nil {
		return nil, fmt.Errorf("カードの初期設定に失敗: %w", err)
	}
	if len(answer) < 57 {
		return nil, fmt.Errorf("カードの初期設定の応答が短すぎます (%d バイト)", len(answer))
	}
	if err := statusError(answer); err != nil {
		return nil, err
	}
	info := &CardInfo{
		CASystemID: binary.BigEndian.Uint16(answer[6:]),
		CardID:     uint64(binary.BigEndian.Uint16(answer[8:]))<<32 | uint64(binary.BigEndian.Uint32(answer[10:])),
		SystemKey:  multi2.ParseSystemKey(answer[16:48]),
	}
	copy(info.InitialCBC[:], answer[48:56])
	return info, nil
}

// statusError checks the trailing status bytes of an answer.
func statusError(answer []byte) error {
	sw := binary.BigEndian.Uint16(answer[len(answer)-2:])
	if sw != 0x9000 {
		return fmt.Errorf("カードがエラーを返しました (SW=%04X)", sw)
	}
	return nil
}

// errNoContract is an ECM the card would not answer with keys.
var errNoContract = errors.New("このチャンネルはカードで視聴できません")

// processECM sends an ECM section body and returns the odd and even data keys.
func processECM(card Card, body []byte) (odd, even []byte, err error) {
	apdu := make([]byte, 0, len(body)+6)
	apdu = append(apdu, commandECMHeader...)
	apdu = append(apdu, byte(len(body)))
	apdu = append(apdu, body...)
	apdu = append(apdu, 0x00)
	answer, err := card.Transmit(apdu)
	if err != nil {
		return nil, nil, err
	}
	if len(answer) < 25 {
		return nil, nil, fmt.Errorf("ECM の応答が短すぎます (%d バイト)", len(answer))
	}
	if err := statusError(answer); err != nil {
		return nil, nil, err
	}
	switch code := binary.BigEndian.Uint16(answer[4:]); code {
	case 0x0200, 0x0400, 0x0800:
	default:
		return nil, nil, fmt.Errorf("%w (戻り値 %04X)", errNoContract, code)
	}
	return answer[6:14], answer[14:22], nil
}
