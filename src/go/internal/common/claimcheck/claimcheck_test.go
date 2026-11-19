package claimcheck

import (
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	commonpb "go.temporal.io/api/common/v1"
	"go.temporal.io/sdk/converter"
	"google.golang.org/protobuf/proto"
)

func newCodec(t *testing.T) (*Codec, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	return New(redis.NewClient(&redis.Options{Addr: mr.Addr()})), mr
}

// TestFormat: the history holds only a key, in the format the Python and Java codecs use,
// and Redis holds the original payload as protobuf under that key.
func TestFormat(t *testing.T) {
	c, mr := newCodec(t)
	original, err := converter.GetDefaultDataConverter().ToPayload(map[string]string{"client_id": "123"})
	require.NoError(t, err)

	encoded, err := c.Encode([]*commonpb.Payload{original})
	require.NoError(t, err)
	require.Len(t, encoded, 1)
	p := encoded[0]
	assert.Equal(t, "claim-checked", string(p.Metadata["encoding"]))
	assert.Equal(t, "v1", string(p.Metadata["temporal.io/claim-check-codec"]))
	assert.NotContains(t, string(p.Data), "123")

	stored, err := mr.Get(string(p.Data))
	require.NoError(t, err)
	var fromRedis commonpb.Payload
	require.NoError(t, proto.Unmarshal([]byte(stored), &fromRedis))
	assert.True(t, proto.Equal(original, &fromRedis))

	decoded, err := c.Decode(encoded)
	require.NoError(t, err)
	assert.True(t, proto.Equal(original, decoded[0]))
}

// TestDecodeOtherPorts: payloads the Java codec (encoding only) or Python codec (version
// only) wrote decode, and payloads that aren't claim-checked pass through.
func TestDecodeOtherPorts(t *testing.T) {
	c, mr := newCodec(t)
	original, err := converter.GetDefaultDataConverter().ToPayload("Waiting KYC")
	require.NoError(t, err)
	raw, err := proto.Marshal(original)
	require.NoError(t, err)
	require.NoError(t, mr.Set("java-key", string(raw)))
	require.NoError(t, mr.Set("python-key", string(raw)))

	javaStyle := &commonpb.Payload{Metadata: map[string][]byte{"encoding": []byte("claim-checked")}, Data: []byte("java-key")}
	pythonStyle := &commonpb.Payload{Metadata: map[string][]byte{"temporal.io/claim-check-codec": []byte("v1")}, Data: []byte("python-key")}
	plain, err := converter.GetDefaultDataConverter().ToPayload("plain")
	require.NoError(t, err)

	decoded, err := c.Decode([]*commonpb.Payload{javaStyle, pythonStyle, plain})
	require.NoError(t, err)
	assert.True(t, proto.Equal(original, decoded[0]))
	assert.True(t, proto.Equal(original, decoded[1]))
	assert.Same(t, plain, decoded[2])
}

// TestDataConverterRoundTrip: values survive the full data converter with the codec.
func TestDataConverterRoundTrip(t *testing.T) {
	mr := miniredis.RunT(t)
	dc := DataConverter(redis.NewClient(&redis.Options{Addr: mr.Addr()}))
	type input struct {
		ClientID      string  `json:"client_id"`
		InitialAmount float64 `json:"initial_amount"`
	}
	payloads, err := dc.ToPayloads(input{"123", 13000})
	require.NoError(t, err)
	assert.Equal(t, "claim-checked", string(payloads.Payloads[0].Metadata["encoding"]))
	var out input
	require.NoError(t, dc.FromPayloads(payloads, &out))
	assert.Equal(t, input{"123", 13000}, out)
}
