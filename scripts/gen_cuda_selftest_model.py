"""Regenerate the tiny GGUF used by the CUDA self-test.

Produces a ~50 KB 1-layer random-weight llama model — just big enough to
exercise a real CUDA forward pass (so the self-test catches missing-kernel
and illegal-instruction failures), small enough to bundle in the installer.

Deterministic (seeded), so re-running yields a byte-identical file.

    pip install gguf numpy
    python scripts/gen_cuda_selftest_model.py
        -> src-tauri/resources/cuda_selftest.gguf
"""
import os

import numpy as np
from gguf import GGUFWriter

OUT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "src-tauri", "resources", "cuda_selftest.gguf",
)

N_VOCAB, N_EMBD, N_HEAD, N_LAYER, N_FF = 32, 32, 4, 1, 64
HEAD_DIM = N_EMBD // N_HEAD
rng = np.random.default_rng(0)


def w(*shape):
    return (rng.standard_normal(shape).astype(np.float32)) * 0.02


g = GGUFWriter(OUT, "llama")
g.add_context_length(2048)
g.add_embedding_length(N_EMBD)
g.add_block_count(N_LAYER)
g.add_feed_forward_length(N_FF)
g.add_head_count(N_HEAD)
g.add_head_count_kv(N_HEAD)
g.add_layer_norm_rms_eps(1e-5)
g.add_rope_dimension_count(HEAD_DIM)

g.add_tokenizer_model("llama")
toks = [f"tok{i}" for i in range(N_VOCAB)]
types = [1] * N_VOCAB
types[0], types[1], types[2] = 2, 3, 3  # unk, bos, eos as control/unknown
g.add_token_list(toks)
g.add_token_scores([0.0] * N_VOCAB)
g.add_token_types(types)
g.add_bos_token_id(1)
g.add_eos_token_id(2)
g.add_unk_token_id(0)

g.add_tensor("token_embd.weight", w(N_VOCAB, N_EMBD))
g.add_tensor("output_norm.weight", np.ones(N_EMBD, np.float32))
g.add_tensor("output.weight", w(N_VOCAB, N_EMBD))
g.add_tensor("blk.0.attn_norm.weight", np.ones(N_EMBD, np.float32))
g.add_tensor("blk.0.attn_q.weight", w(N_EMBD, N_EMBD))
g.add_tensor("blk.0.attn_k.weight", w(N_EMBD, N_EMBD))
g.add_tensor("blk.0.attn_v.weight", w(N_EMBD, N_EMBD))
g.add_tensor("blk.0.attn_output.weight", w(N_EMBD, N_EMBD))
g.add_tensor("blk.0.ffn_norm.weight", np.ones(N_EMBD, np.float32))
g.add_tensor("blk.0.ffn_gate.weight", w(N_FF, N_EMBD))
g.add_tensor("blk.0.ffn_down.weight", w(N_EMBD, N_FF))
g.add_tensor("blk.0.ffn_up.weight", w(N_FF, N_EMBD))

g.write_header_to_file()
g.write_kv_data_to_file()
g.write_tensors_to_file()
g.close()
print("wrote", OUT)
