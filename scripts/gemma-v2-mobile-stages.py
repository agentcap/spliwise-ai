#!/usr/bin/env python3
"""Resume conversion in separate processes so export graphs don't remain in RAM."""
import argparse
import dataclasses
import json
from pathlib import Path
import time
import runpy

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / '.tools/finetune/gemma4-e2b-v2/android'
WORK = OUT / 'mobile-export/tmpeg4px6__'


def configuration():
    from litert_torch.generative.export_hf.core.exportable_module_config import ExportableModuleConfig
    return ExportableModuleConfig(model=str(OUT / 'merged-fp32'), output_dir=str(OUT / 'mobile-export'),
        task='text_generation', prefill_lengths=[128], cache_length=16384,
        externalize_embedder=True, quantization_recipe=None,
        experimental_lightweight_conversion=True, moe_exports_implementation='eager',
        jinja_chat_template_override=str(ROOT / '.tools/finetune/gemma4-e2b-v1/export-research/mobile-chat-template.jinja'),
        work_dir=str(WORK), sampler_top_k=1, sampler_top_p=1.0, sampler_temperature=0.0)


def export_part(stage):
    # The checkpoints were verified finite by the preparation pass.
    runpy.run_path(str(ROOT / 'scripts/gemma-v2-export-runner.py'), run_name='export_patches')
    from litert_torch.generative.export_hf.core import export_lib
    from litert_torch._convert import interface as converter_utils
    original = converter_utils.Converter.convert
    def convert(self, *args, **kwargs):
        kwargs.setdefault('lightweight_conversion', True)
        return original(self, *args, **kwargs)
    converter_utils.Converter.convert = convert
    config = configuration()
    source = export_lib.load_model(config.model, config, task='text_generation')
    config = export_lib.update_export_config(config, source)
    result = export_lib.ExportedModelArtifacts()
    function = export_lib.export_embedder_model if stage == 'embedder' else export_lib.export_additional_models
    result = function(source, config, result)
    (OUT / f'{stage}-stage.json').write_text(json.dumps(dataclasses.asdict(result), indent=2) + '\n')


def pack():
    from types import SimpleNamespace
    from transformers import AutoConfig, AutoTokenizer, GenerationConfig
    from litert_torch.generative.export_hf.core import export_lib, litert_lm_builder
    config = configuration()
    cfg = AutoConfig.from_pretrained(config.model)
    source = export_lib.SourceModelArtifacts(
        model=SimpleNamespace(config=cfg, generation_config=GenerationConfig.from_pretrained(config.model)),
        model_config=cfg, text_model_config=cfg.get_text_config(), tokenizer=AutoTokenizer.from_pretrained(config.model))
    config = export_lib.update_export_config(config, source)
    result = export_lib.ExportedModelArtifacts(
        prefill_decode_model_path=str(WORK / 'model_quantized.tflite'),
        embedder_model_path=str(WORK / 'embedder_quantized.tflite'),
        additional_model_paths={'per_layer_embedder': str(WORK / 'per_layer_embedder_quantized.tflite')})
    for path in (result.prefill_decode_model_path, result.embedder_model_path,
                 result.additional_model_paths['per_layer_embedder']):
        assert Path(path).is_file(), path
    result = export_lib.export_tokenizer(source, config, result)
    result = litert_lm_builder.package_model(source, config, result)
    (OUT / 'pack-stage.json').write_text(json.dumps(dataclasses.asdict(result), indent=2) + '\n')


def quantize(source):
    from ai_edge_quantizer import quantizer, recipe
    started = time.time()
    source = Path(source).resolve()
    assert source.is_relative_to(OUT)
    dest = source.with_name(source.stem + '_quantized.tflite')
    assert not dest.exists()
    engine = quantizer.Quantizer(str(source))
    engine.load_quantization_recipe(
        recipe.dynamic_wi4c_afp32(operation_name=recipe.TFLOperationName.EMBEDDING_LOOKUP)
        + recipe.dynamic_wi8c_afp32(operation_name=recipe.TFLOperationName.FULLY_CONNECTED))
    engine.quantize().export_model(str(dest))
    (OUT / f'quantization-{source.stem}-stage.json').write_text(json.dumps(dict(
        source=str(source), output=str(dest), bytes=dest.stat().st_size,
        seconds=time.time() - started), indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('stage', choices=('quantize', 'embedder', 'additional', 'pack'))
    parser.add_argument('source', nargs='?')
    args = parser.parse_args()
    if args.stage == 'quantize':
        quantize(args.source)
    elif args.stage == 'pack':
        pack()
    else:
        export_part(args.stage)
