"""CUDA self-test probe.

Loads a tiny bundled GGUF on the GPU (n_gpu_layers=-1) and runs a single
token. Exit 0 means the CUDA llama-cpp backend actually works on this
machine's GPU+driver; any non-zero exit — or a hard native crash, which
shows up as an abnormal exit code — means it does not, and the caller
(setup_manager) falls back to the CPU wheel.

Run in an isolated subprocess on purpose: a CUDA backend that is
incompatible with the GPU (too new), the driver (too old), or the CPU ISA
can abort the process. Doing that here keeps it out of the server process.

Usage: python cuda_selftest.py <model.gguf>
"""
import os
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: cuda_selftest.py <model.gguf>", file=sys.stderr)
        return 2
    model = sys.argv[1]

    # The CUDA runtime DLLs live under env_dir/nvidia/*/bin. build_python_env
    # already puts them on PATH for this subprocess, but add_dll_directory too
    # so dependent-DLL resolution is robust regardless of loader search order.
    env_dir = os.path.join(os.environ.get("APPDATA", "."), "LocalSub", "python-env")
    for d in (
        os.path.join(env_dir, "nvidia", "cuda_runtime", "bin"),
        os.path.join(env_dir, "nvidia", "cublas", "bin"),
    ):
        if os.path.isdir(d):
            try:
                os.add_dll_directory(d)
            except OSError:
                pass

    try:
        from llama_cpp import Llama
    except Exception as e:  # noqa: BLE001 - any import/DLL failure means "no GPU"
        print(f"cuda self-test: import failed: {e}", file=sys.stderr)
        return 3

    try:
        llm = Llama(model_path=model, n_gpu_layers=-1, n_ctx=128, verbose=False)
        # Force a real GPU forward pass without depending on string tokenization
        # (the tiny test vocab can't tokenize arbitrary text). Feeding the BOS
        # token runs the compute graph on the offloaded layers, which is what
        # catches a missing-kernel / incompatible-GPU / bad-wheel failure.
        bos = llm.token_bos()
        token = bos if isinstance(bos, int) and bos >= 0 else 0
        llm.eval([token])
    except Exception as e:  # noqa: BLE001 - crash/incompat -> caller uses CPU
        print(f"cuda self-test: gpu load/infer failed: {e}", file=sys.stderr)
        return 4

    print("cuda self-test: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
