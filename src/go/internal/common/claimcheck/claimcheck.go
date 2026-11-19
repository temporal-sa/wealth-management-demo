// Package claimcheck is the optional claim-check payload codec (USE_CLAIM_CHECK).
//
// It stores each payload in Redis under a new UUID and puts only that key in the
// workflow's event history. The format is the same as the other ports' Python and Java
// codecs, so they can read each other's payloads:
//
//   - Redis key: the UUID, as a plain string;
//   - Redis value: the original Payload, serialized as protobuf;
//   - payload in history: metadata encoding = "claim-checked" and
//     temporal.io/claim-check-codec = "v1", data = the UUID.
//
// Every component that reads or writes payloads (the worker, the API, the scripts and the
// Java worker) must use the codec, or it can't read the others' payloads.
package claimcheck

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	commonpb "go.temporal.io/api/common/v1"
	"go.temporal.io/sdk/converter"
	"google.golang.org/protobuf/proto"
)

const (
	encodingKey     = "encoding"
	encoding        = "claim-checked"
	codecVersionKey = "temporal.io/claim-check-codec"
	codecVersion    = "v1"
	redisTimeout    = 10 * time.Second
)

// Codec is the claim-check PayloadCodec.
type Codec struct {
	rdb *redis.Client
}

// New returns a claim-check codec storing payloads in the given Redis.
func New(rdb *redis.Client) *Codec { return &Codec{rdb: rdb} }

// Encode stores each payload in Redis and replaces it with its key.
func (c *Codec) Encode(payloads []*commonpb.Payload) ([]*commonpb.Payload, error) {
	ctx, cancel := context.WithTimeout(context.Background(), redisTimeout)
	defer cancel()
	out := make([]*commonpb.Payload, len(payloads))
	for i, p := range payloads {
		value, err := proto.Marshal(p)
		if err != nil {
			return nil, fmt.Errorf("claim check: serializing payload: %w", err)
		}
		id := uuid.NewString()
		if err := c.rdb.Set(ctx, id, value, 0).Err(); err != nil {
			return nil, fmt.Errorf("claim check: storing payload in Redis: %w", err)
		}
		out[i] = &commonpb.Payload{
			Metadata: map[string][]byte{
				encodingKey:     []byte(encoding),
				codecVersionKey: []byte(codecVersion),
			},
			Data: []byte(id),
		}
	}
	return out, nil
}

// Decode replaces each claim-checked payload with the original from Redis. Payloads that
// aren't claim-checked are returned as they are.
func (c *Codec) Decode(payloads []*commonpb.Payload) ([]*commonpb.Payload, error) {
	ctx, cancel := context.WithTimeout(context.Background(), redisTimeout)
	defer cancel()
	out := make([]*commonpb.Payload, len(payloads))
	for i, p := range payloads {
		if !IsClaimChecked(p) {
			out[i] = p
			continue
		}
		id := string(p.GetData())
		value, err := c.rdb.Get(ctx, id).Bytes()
		if err != nil {
			return nil, fmt.Errorf("claim check: reading payload %s from Redis: %w", id, err)
		}
		var original commonpb.Payload
		if err := proto.Unmarshal(value, &original); err != nil {
			return nil, fmt.Errorf("claim check: parsing payload %s: %w", id, err)
		}
		out[i] = &original
	}
	return out, nil
}

// IsClaimChecked reports whether a payload is a claim-check key. The Python codec checks
// the codec-version metadata and the Java codec the encoding, so either one counts.
func IsClaimChecked(p *commonpb.Payload) bool {
	md := p.GetMetadata()
	return string(md[encodingKey]) == encoding || string(md[codecVersionKey]) == codecVersion
}

// DataConverter returns the default data converter with the claim-check codec.
func DataConverter(rdb *redis.Client) converter.DataConverter {
	return converter.NewCodecDataConverter(converter.GetDefaultDataConverter(), New(rdb))
}
