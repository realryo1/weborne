// SPDX-License-Identifier: Apache-2.0 OR GPL-2.0-or-later

// Package multi2 is the MULTI2 block cipher as ARIB STD-B25 uses it: 64-bit
// blocks, a 256-bit system key, a 64-bit data key (Ks) and four rounds, run in
// CBC mode with an OFB tail for a payload that does not end on a block.
package multi2

import (
	"encoding/binary"
	"math/bits"
)

// rounds is what ARIB STD-B25 fixes; each round is the eight π steps.
const rounds = 4

// SystemKey is the 256-bit system key the card hands over, as eight words.
type SystemKey [8]uint32

// ParseSystemKey reads the 32 bytes of a system key, big-endian.
func ParseSystemKey(b []byte) SystemKey {
	var key SystemKey
	for i := range key {
		key[i] = binary.BigEndian.Uint32(b[i*4:])
	}
	return key
}

// Cipher is one data key scheduled against the system key, with the CBC
// initial value.
type Cipher struct {
	work    [8]uint32
	initial [2]uint32
}

// New schedules a data key (8 bytes, big-endian) against a system key.
// initialCBC is the 8-byte initial value the card reports.
func New(system SystemKey, dataKey, initialCBC []byte) *Cipher {
	c := &Cipher{}
	l := binary.BigEndian.Uint32(dataKey[0:])
	r := binary.BigEndian.Uint32(dataKey[4:])
	c.initial[0] = binary.BigEndian.Uint32(initialCBC[0:])
	c.initial[1] = binary.BigEndian.Uint32(initialCBC[4:])

	l, r = pi1(l, r)
	l, r = pi2(l, r, system[0])
	c.work[0] = l
	l, r = pi3(l, r, system[1], system[2])
	c.work[1] = r
	l, r = pi4(l, r, system[3])
	c.work[2] = l
	l, r = pi1(l, r)
	c.work[3] = r
	l, r = pi2(l, r, system[4])
	c.work[4] = l
	l, r = pi3(l, r, system[5], system[6])
	c.work[5] = r
	l, r = pi4(l, r, system[7])
	c.work[6] = l
	_, r = pi1(l, r)
	c.work[7] = r
	return c
}

func pi1(l, r uint32) (uint32, uint32) { return l, r ^ l }

func pi2(l, r, a uint32) (uint32, uint32) {
	t0 := r + a
	t1 := bits.RotateLeft32(t0, 1) + t0 - 1
	t2 := bits.RotateLeft32(t1, 4) ^ t1
	return l ^ t2, r
}

func pi3(l, r, a, b uint32) (uint32, uint32) {
	t0 := l + a
	t1 := bits.RotateLeft32(t0, 2) + t0 + 1
	t2 := bits.RotateLeft32(t1, 8) ^ t1
	t3 := t2 + b
	t4 := bits.RotateLeft32(t3, 1) - t3
	t5 := bits.RotateLeft32(t4, 16) ^ (t4 | l)
	return l, r ^ t5
}

func pi4(l, r, a uint32) (uint32, uint32) {
	t0 := r + a
	t1 := bits.RotateLeft32(t0, 2) + t0 + 1
	return l ^ t1, r
}

func (c *Cipher) encrypt(l, r uint32) (uint32, uint32) {
	k := &c.work
	for i := 0; i < rounds; i++ {
		l, r = pi1(l, r)
		l, r = pi2(l, r, k[0])
		l, r = pi3(l, r, k[1], k[2])
		l, r = pi4(l, r, k[3])
		l, r = pi1(l, r)
		l, r = pi2(l, r, k[4])
		l, r = pi3(l, r, k[5], k[6])
		l, r = pi4(l, r, k[7])
	}
	return l, r
}

func (c *Cipher) decrypt(l, r uint32) (uint32, uint32) {
	k := &c.work
	for i := 0; i < rounds; i++ {
		l, r = pi4(l, r, k[7])
		l, r = pi3(l, r, k[5], k[6])
		l, r = pi2(l, r, k[4])
		l, r = pi1(l, r)
		l, r = pi4(l, r, k[3])
		l, r = pi3(l, r, k[1], k[2])
		l, r = pi2(l, r, k[0])
		l, r = pi1(l, r)
	}
	return l, r
}

// Decrypt descrambles one packet payload in place.
func (c *Cipher) Decrypt(p []byte) {
	cbcL, cbcR := c.initial[0], c.initial[1]
	for len(p) >= 8 {
		srcL := binary.BigEndian.Uint32(p[0:])
		srcR := binary.BigEndian.Uint32(p[4:])
		l, r := c.decrypt(srcL, srcR)
		binary.BigEndian.PutUint32(p[0:], l^cbcL)
		binary.BigEndian.PutUint32(p[4:], r^cbcR)
		cbcL, cbcR = srcL, srcR
		p = p[8:]
	}
	if len(p) > 0 {
		l, r := c.encrypt(cbcL, cbcR)
		var ofb [8]byte
		binary.BigEndian.PutUint32(ofb[0:], l)
		binary.BigEndian.PutUint32(ofb[4:], r)
		for i := range p {
			p[i] ^= ofb[i]
		}
	}
}
