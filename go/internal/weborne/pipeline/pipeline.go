// SPDX-License-Identifier: Apache-2.0 OR GPL-2.0-or-later

// Package pipeline turns the raw broadcast transport stream into one service
// a decoder can play: it reads the PAT, PMTs and SDT, asks the card for the
// keys each ECM carries, descrambles the service's packets and passes on only
// that service, under a PAT rewritten to list it alone.
package pipeline

import (
	"bytes"
	"encoding/binary"
	"sync"

	"github.com/Till0196/coax/internal/weborne/multi2"
	"github.com/Till0196/coax/pkg/isdb"
	"github.com/Till0196/coax/pkg/mpegts"
)

const packetSize = 188

// PIDs and table IDs the pipeline reads.
const (
	pidPAT        = 0x0000
	pidSDT        = 0x0011
	tableECM      = 0x82
	tableSDTOwn   = 0x42
	tableSDTOther = 0x46
)

// Stream types the pipeline keeps.
const (
	streamMPEG2Video = 0x02
	streamAACADTS    = 0x0f
	streamAACLATM    = 0x11
	streamH264       = 0x1b
	streamH265       = 0x24
)

// Stream is one elementary stream of a service.
type Stream struct {
	PID  uint16 `json:"pid"`
	Type byte   `json:"type"`
}

// Service is one program of the multiplex.
type Service struct {
	ID       uint16   `json:"id"`
	Name     string   `json:"name"`
	Kind     byte     `json:"kind"`
	PMTPID   uint16   `json:"pmtPid"`
	PCRPID   uint16   `json:"pcrPid"`
	Video    []Stream `json:"video"`
	Audio    []Stream `json:"audio"`
	ECMPID   uint16   `json:"ecmPid"`
	Codec    string   `json:"codec"`
	hasPMT   bool
	pmtOut   []byte // PMT reduced to the kept streams, one packet
	ecmOfPID map[uint16]uint16
}

// Status is what the pipeline reports about descrambling.
type Status struct {
	Packets    uint64 `json:"packets"`
	Scrambled  uint64 `json:"scrambled"`
	Dropped    uint64 `json:"dropped"`
	ECMOK      uint64 `json:"ecmOk"`
	ECMError   string `json:"ecmError,omitempty"`
	Selected   uint16 `json:"selected"`
	HaveKeys   bool   `json:"haveKeys"`
	CardReady  bool   `json:"cardReady"`
	TSID       uint16 `json:"tsid"`
}

type ecmState struct {
	collector mpegts.SectionCollector
	last      []byte
	odd, even *multi2.Cipher
}

type ecmJob struct {
	pid  uint16
	body []byte
}

// Pipeline is safe to drive from one goroutine while the card answers ECMs on
// another.
type Pipeline struct {
	mu   sync.Mutex
	card Card
	info *CardInfo

	patCollector mpegts.SectionCollector
	patVersion   int
	tsid         uint16
	pmtPIDs      map[uint16]uint16 // PMT PID → service ID
	pmtCollector map[uint16]*mpegts.SectionCollector
	pmtLast      map[uint16][]byte
	sdtCollector mpegts.SectionCollector
	sdtLast      []byte
	services     map[uint16]*Service
	order        []uint16
	ecms         map[uint16]*ecmState

	selected   uint16
	auto       bool
	keep       map[uint16]bool
	patOut     []byte
	patCC      byte
	patVer     byte
	needPAT    bool
	jobs       chan ecmJob
	inflight   int
	status     Status
	changed    bool
	onServices func([]Service)
}

// New makes a pipeline. card may be nil, in which case scrambled packets are
// dropped.
func New(card Card, info *CardInfo, onServices func([]Service)) *Pipeline {
	p := &Pipeline{
		card:         card,
		info:         info,
		patVersion:   -1,
		pmtPIDs:      map[uint16]uint16{},
		pmtCollector: map[uint16]*mpegts.SectionCollector{},
		pmtLast:      map[uint16][]byte{},
		services:     map[uint16]*Service{},
		ecms:         map[uint16]*ecmState{},
		auto:         true,
		keep:         map[uint16]bool{},
		jobs:         make(chan ecmJob, 8),
		onServices:   onServices,
	}
	p.status.CardReady = card != nil && info != nil
	go p.ecmWorker()
	return p
}

// Close stops the ECM worker.
func (p *Pipeline) Close() { close(p.jobs) }

// Select picks the service to pass on; 0 goes back to choosing the first TV
// service by itself.
func (p *Pipeline) Select(id uint16) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.auto = id == 0
	p.selected = id
	p.rebuildKeepLocked()
}

// Status reports the counters.
func (p *Pipeline) Status() Status {
	p.mu.Lock()
	defer p.mu.Unlock()
	s := p.status
	s.Selected = p.selected
	s.TSID = p.tsid
	if svc := p.services[p.selected]; svc != nil && svc.ECMPID != 0 {
		e := p.ecms[svc.ECMPID]
		s.HaveKeys = e != nil && e.odd != nil
	}
	return s
}

// PendingECMs reports how many ECMs are waiting for the card.
func (p *Pipeline) PendingECMs() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.inflight
}

// Services lists the services in PAT order.
func (p *Pipeline) Services() []Service {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.servicesLocked()
}

func (p *Pipeline) servicesLocked() []Service {
	out := make([]Service, 0, len(p.order))
	for _, id := range p.order {
		if svc := p.services[id]; svc != nil && svc.hasPMT {
			out = append(out, *svc)
		}
	}
	return out
}

// Process takes whole 188-byte packets and appends the output packets to out.
func (p *Pipeline) Process(in []byte, out []byte) []byte {
	p.mu.Lock()
	for len(in) >= packetSize {
		packet := in[:packetSize]
		in = in[packetSize:]
		if packet[0] != 0x47 {
			continue
		}
		out = p.packetLocked(packet, out)
	}
	var notify []Service
	if p.changed && p.onServices != nil {
		notify = p.servicesLocked()
		p.changed = false
	}
	p.mu.Unlock()
	if notify != nil {
		p.onServices(notify)
	}
	return out
}

func (p *Pipeline) packetLocked(packet []byte, out []byte) []byte {
	p.status.Packets++
	if packet[1]&0x80 != 0 {
		return out
	}
	pid := uint16(packet[1]&0x1f)<<8 | uint16(packet[2])
	tsc := packet[3] >> 6

	switch {
	case pid == pidPAT:
		p.pushPAT(packet)
		if p.patOut != nil {
			out = append(out, p.nextPATLocked()...)
		}
		return out
	case pid == pidSDT:
		p.pushSDT(packet)
		return out
	}
	if _, ok := p.pmtPIDs[pid]; ok {
		p.pushPMT(pid, packet)
		if svc := p.services[p.selected]; svc != nil && svc.PMTPID == pid && svc.pmtOut != nil {
			// The reduced PMT goes out in place of the original's first packet.
			if packet[1]&0x40 != 0 {
				out = append(out, svc.pmtOut...)
				svc.pmtOut[3] = svc.pmtOut[3]&0xf0 | (svc.pmtOut[3]+1)&0x0f
			}
			return out
		}
	}
	if e := p.ecms[pid]; e != nil {
		p.pushECM(pid, e, packet)
	}
	if !p.keep[pid] {
		return out
	}
	if p.needPAT && p.patOut != nil {
		out = append(out, p.nextPATLocked()...)
		p.needPAT = false
	}
	if tsc&2 == 0 {
		return append(out, packet...)
	}
	p.status.Scrambled++
	cipher := p.cipherLocked(pid, tsc)
	if cipher == nil {
		p.status.Dropped++
		return out
	}
	start := len(out)
	out = append(out, packet...)
	clear := out[start : start+packetSize]
	clear[3] &^= 0xc0
	if offset, ok := payloadOffset(clear); ok {
		cipher.Decrypt(clear[offset:])
	}
	return out
}

func payloadOffset(packet []byte) (int, bool) {
	afc := (packet[3] >> 4) & 3
	if afc&1 == 0 {
		return 0, false
	}
	offset := 4
	if afc == 3 {
		offset += 1 + int(packet[4])
	}
	return offset, offset < packetSize
}

func (p *Pipeline) cipherLocked(pid uint16, tsc byte) *multi2.Cipher {
	svc := p.services[p.selected]
	if svc == nil {
		return nil
	}
	ecmPID, ok := svc.ecmOfPID[pid]
	if !ok {
		ecmPID = svc.ECMPID
	}
	e := p.ecms[ecmPID]
	if e == nil {
		return nil
	}
	if tsc == 3 {
		return e.odd
	}
	return e.even
}

// sections pushes a packet into a collector and returns the whole, valid
// sections it completed.
func sections(collector *mpegts.SectionCollector, packet []byte) [][]byte {
	_, payload, start, ok := mpegts.Payload(packet)
	if !ok {
		return nil
	}
	collector.Push(payload, start)
	var out [][]byte
	for _, s := range collector.Take() {
		if mpegts.ValidSection(s) {
			out = append(out, s)
		}
	}
	return out
}

func (p *Pipeline) pushPAT(packet []byte) {
	for _, s := range sections(&p.patCollector, packet) {
		if s[0] != 0x00 || len(s) < 12 {
			continue
		}
		version := int(s[5]>>1) & 0x1f
		if version == p.patVersion {
			continue
		}
		p.patVersion = version
		p.tsid = binary.BigEndian.Uint16(s[3:])
		length := int(binary.BigEndian.Uint16(s[1:])&0x0fff) + 3
		p.pmtPIDs = map[uint16]uint16{}
		p.order = p.order[:0]
		seen := map[uint16]bool{}
		for i := 8; i+4 <= length-4; i += 4 {
			number := binary.BigEndian.Uint16(s[i:])
			pmt := binary.BigEndian.Uint16(s[i+2:]) & 0x1fff
			if number == 0 {
				continue
			}
			seen[number] = true
			p.pmtPIDs[pmt] = number
			p.order = append(p.order, number)
			svc := p.services[number]
			if svc == nil {
				svc = &Service{ID: number}
				p.services[number] = svc
			}
			if svc.PMTPID != pmt {
				svc.PMTPID = pmt
				svc.hasPMT = false
				delete(p.pmtLast, pmt)
			}
			if p.pmtCollector[pmt] == nil {
				p.pmtCollector[pmt] = &mpegts.SectionCollector{}
			}
		}
		for id := range p.services {
			if !seen[id] {
				delete(p.services, id)
			}
		}
		p.changed = true
		p.rebuildKeepLocked()
	}
}

func (p *Pipeline) pushPMT(pid uint16, packet []byte) {
	for _, s := range sections(p.pmtCollector[pid], packet) {
		if s[0] != 0x02 || len(s) < 16 {
			continue
		}
		if bytes.Equal(p.pmtLast[pid], s) {
			continue
		}
		p.pmtLast[pid] = append([]byte(nil), s...)
		number := binary.BigEndian.Uint16(s[3:])
		svc := p.services[number]
		if svc == nil || svc.PMTPID != pid {
			continue
		}
		p.parsePMT(svc, s)
		p.changed = true
		p.rebuildKeepLocked()
	}
}

func caPID(descriptors []byte) (uint16, bool) {
	for len(descriptors) >= 2 {
		tag, length := descriptors[0], int(descriptors[1])
		if 2+length > len(descriptors) {
			break
		}
		if tag == 0x09 && length >= 4 {
			return binary.BigEndian.Uint16(descriptors[4:]) & 0x1fff, true
		}
		descriptors = descriptors[2+length:]
	}
	return 0, false
}

func (p *Pipeline) parsePMT(svc *Service, s []byte) {
	length := int(binary.BigEndian.Uint16(s[1:])&0x0fff) + 3
	end := length - 4
	svc.PCRPID = binary.BigEndian.Uint16(s[8:]) & 0x1fff
	infoLength := int(binary.BigEndian.Uint16(s[10:]) & 0x0fff)
	if 12+infoLength > end {
		return
	}
	svc.ECMPID = 0
	if pid, ok := caPID(s[12 : 12+infoLength]); ok {
		svc.ECMPID = pid
	}
	svc.Video, svc.Audio = nil, nil
	svc.ecmOfPID = map[uint16]uint16{}
	for i := 12 + infoLength; i+5 <= end; {
		kind := s[i]
		pid := binary.BigEndian.Uint16(s[i+1:]) & 0x1fff
		esLength := int(binary.BigEndian.Uint16(s[i+3:]) & 0x0fff)
		if i+5+esLength > end {
			break
		}
		if ecm, ok := caPID(s[i+5 : i+5+esLength]); ok {
			svc.ecmOfPID[pid] = ecm
		}
		switch kind {
		case streamMPEG2Video, streamH264, streamH265:
			svc.Video = append(svc.Video, Stream{PID: pid, Type: kind})
		case streamAACADTS, streamAACLATM:
			svc.Audio = append(svc.Audio, Stream{PID: pid, Type: kind})
		}
		i += 5 + esLength
	}
	svc.pmtOut = reducePMT(s, svc.PMTPID)
	svc.Codec = ""
	if len(svc.Video) > 0 {
		switch svc.Video[0].Type {
		case streamMPEG2Video:
			svc.Codec = "mpeg2"
		case streamH264:
			svc.Codec = "h264"
		case streamH265:
			svc.Codec = "hevc"
		}
	}
	svc.hasPMT = true
}

// reducePMT rebuilds a PMT section keeping only the video and audio streams,
// so the decoder does not wait to identify data and caption streams it will
// never receive. Returns nil when the result does not fit one packet.
func reducePMT(s []byte, pid uint16) []byte {
	length := int(binary.BigEndian.Uint16(s[1:])&0x0fff) + 3
	end := length - 4
	infoLength := int(binary.BigEndian.Uint16(s[10:]) & 0x0fff)
	section := append([]byte(nil), s[:12+infoLength]...)
	for i := 12 + infoLength; i+5 <= end; {
		esLength := int(binary.BigEndian.Uint16(s[i+3:]) & 0x0fff)
		if i+5+esLength > end {
			break
		}
		switch s[i] {
		case streamMPEG2Video, streamH264, streamH265, streamAACADTS, streamAACLATM:
			section = append(section, s[i:i+5+esLength]...)
		}
		i += 5 + esLength
	}
	sectionLength := len(section) - 3 + 4
	section[1] = s[1]&0xf0 | byte(sectionLength>>8)&0x0f
	section[2] = byte(sectionLength)
	section = binary.BigEndian.AppendUint32(section, mpegts.CRC32(section))
	if len(section) > packetSize-5 {
		return nil
	}
	packet := make([]byte, packetSize)
	for i := range packet {
		packet[i] = 0xff
	}
	packet[0], packet[1], packet[2], packet[3] = 0x47, 0x40|byte(pid>>8)&0x1f, byte(pid), 0x10
	copy(packet[5:], section)
	return packet
}

func (p *Pipeline) pushSDT(packet []byte) {
	for _, s := range sections(&p.sdtCollector, packet) {
		if s[0] != tableSDTOwn || len(s) < 15 {
			continue
		}
		if bytes.Equal(p.sdtLast, s) {
			continue
		}
		p.sdtLast = append(p.sdtLast[:0], s...)
		length := int(binary.BigEndian.Uint16(s[1:])&0x0fff) + 3
		end := length - 4
		for i := 11; i+5 <= end; {
			id := binary.BigEndian.Uint16(s[i:])
			loop := int(binary.BigEndian.Uint16(s[i+3:]) & 0x0fff)
			if i+5+loop > end {
				break
			}
			d := s[i+5 : i+5+loop]
			for len(d) >= 2 {
				tag, dl := d[0], int(d[1])
				if 2+dl > len(d) {
					break
				}
				if tag == 0x48 {
					if naming, ok := isdb.ParseServiceDescriptor(d[2 : 2+dl]); ok {
						if svc := p.services[id]; svc != nil {
							svc.Name = naming.Name
							svc.Kind = naming.Kind
							p.changed = true
						}
					}
				}
				d = d[2+dl:]
			}
			i += 5 + loop
		}
	}
}

func (p *Pipeline) pushECM(pid uint16, e *ecmState, packet []byte) {
	for _, s := range sections(&e.collector, packet) {
		if s[0] != tableECM || len(s) < 12 {
			continue
		}
		if bytes.Equal(e.last, s) {
			continue
		}
		e.last = append(e.last[:0], s...)
		body := append([]byte(nil), s[8:len(s)-4]...)
		select {
		case p.jobs <- ecmJob{pid: pid, body: body}:
			p.inflight++
		default:
		}
	}
}

func (p *Pipeline) ecmWorker() {
	for job := range p.jobs {
		if p.card == nil || p.info == nil {
			p.mu.Lock()
			p.inflight--
			p.mu.Unlock()
			continue
		}
		odd, even, err := processECM(p.card, job.body)
		p.mu.Lock()
		p.inflight--
		if err != nil {
			p.status.ECMError = err.Error()
			if e := p.ecms[job.pid]; e != nil {
				e.last = nil // try again with the next copy
			}
		} else {
			p.status.ECMError = ""
			p.status.ECMOK++
			if e := p.ecms[job.pid]; e != nil {
				e.odd = multi2.New(p.info.SystemKey, odd, p.info.InitialCBC[:])
				e.even = multi2.New(p.info.SystemKey, even, p.info.InitialCBC[:])
			}
		}
		p.mu.Unlock()
	}
}

// rebuildKeepLocked works out which PIDs the selected service needs, and
// which ECM PIDs to follow.
func (p *Pipeline) rebuildKeepLocked() {
	if p.auto {
		p.selected = 0
		for _, id := range p.order {
			if svc := p.services[id]; svc != nil && svc.hasPMT && svc.Codec == "mpeg2" && len(svc.Audio) > 0 {
				p.selected = id
				break
			}
		}
		if p.selected == 0 {
			for _, id := range p.order {
				if svc := p.services[id]; svc != nil && svc.hasPMT && len(svc.Video) > 0 {
					p.selected = id
					break
				}
			}
		}
	}
	keep := map[uint16]bool{}
	ecmPIDs := map[uint16]bool{}
	svc := p.services[p.selected]
	if svc != nil && svc.hasPMT {
		keep[svc.PMTPID] = true
		if svc.PCRPID != 0x1fff {
			keep[svc.PCRPID] = true
		}
		for _, st := range append(append([]Stream(nil), svc.Video...), svc.Audio...) {
			keep[st.PID] = true
		}
		if svc.ECMPID != 0 {
			ecmPIDs[svc.ECMPID] = true
		}
		for _, ecm := range svc.ecmOfPID {
			ecmPIDs[ecm] = true
		}
	}
	for pid := range p.ecms {
		if !ecmPIDs[pid] {
			delete(p.ecms, pid)
		}
	}
	for pid := range ecmPIDs {
		if p.ecms[pid] == nil {
			p.ecms[pid] = &ecmState{}
		}
	}
	changed := len(keep) != len(p.keep)
	for pid := range keep {
		if !p.keep[pid] {
			changed = true
		}
	}
	p.keep = keep
	if svc == nil || !svc.hasPMT {
		p.patOut = nil
		return
	}
	if changed || p.patOut == nil {
		p.patVer = (p.patVer + 1) & 0x1f
		p.patOut = buildPAT(p.tsid, p.patVer, svc.ID, svc.PMTPID)
		p.needPAT = true
	}
}

func buildPAT(tsid uint16, version byte, service, pmt uint16) []byte {
	section := []byte{
		0x00, 0xb0, 13,
		byte(tsid >> 8), byte(tsid),
		0xc1 | version<<1, 0x00, 0x00,
		byte(service >> 8), byte(service), 0xe0 | byte(pmt>>8), byte(pmt),
	}
	section = binary.BigEndian.AppendUint32(section, mpegts.CRC32(section))
	packet := make([]byte, packetSize)
	for i := range packet {
		packet[i] = 0xff
	}
	packet[0], packet[1], packet[2], packet[3] = 0x47, 0x40, 0x00, 0x10
	packet[4] = 0
	copy(packet[5:], section)
	return packet
}

func (p *Pipeline) nextPATLocked() []byte {
	packet := append([]byte(nil), p.patOut...)
	packet[3] = 0x10 | p.patCC
	p.patCC = (p.patCC + 1) & 0x0f
	return packet
}
