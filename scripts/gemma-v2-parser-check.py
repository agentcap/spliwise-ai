#!/usr/bin/env python3
"""Reject malformed native parser shapes without aborting an evaluation."""
import importlib.util
from pathlib import Path

sp=importlib.util.spec_from_file_location('model',Path(__file__).with_name('gemma-v2-model.py'))
m=importlib.util.module_from_spec(sp);sp.loader.exec_module(m)
class Fake:
    def __init__(self,result):self.result=result
    def parse_response(self,raw):
        if isinstance(self.result,Exception):raise self.result
        return self.result
bad=[None,[],{'tool_calls':{}},{'tool_calls':[{}]},
    {'tool_calls':[{'function':{'name':'x','arguments':'{}'}}]},
    {'tool_calls':[{'function':{'name':None,'arguments':{}}}]},ValueError('bad syntax')]
for value in bad:
    result=m.parsed_response(Fake(value),'<|tool_call>broken')
    assert result['tool_calls'][0]['function']['name']=='__malformed_response__'
good={'tool_calls':[{'function':{'name':'lookup_context','arguments':{'query':'trip','offset':0}}}]}
assert m.parsed_response(Fake(good),'<|tool_call>call:lookup_context{}')==good
assert m.parsed_response(Fake({'content':'I cannot send messages.'}),'I cannot send messages.')=={'content':'I cannot send messages.'}
print('Malformed-response boundary checks passed.')
