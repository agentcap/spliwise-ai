#!/usr/bin/env python3
"""Meaningful guard checks for the experimental bookkeeping boundary."""
import importlib.util
from pathlib import Path

sp=importlib.util.spec_from_file_location('interface',Path(__file__).with_name('gemma-v2-interface.py'))
ui=importlib.util.module_from_spec(sp);sp.loader.exec_module(ui)
summary={'selectedExpenses':[dict(id='observed',version=7,bankCategory='Groceries')]}
ctx=dict(summary=summary,responses=[],user_text='Divide this for @me and @dara.')
a=ui.native_args('propose_split',dict(mode='percent',participants=['@me','@dara'],shares=[12.34,87.66]),**ctx)
assert a['transactionId']=='observed' and a['version']==7 and a['values']==[1234,8766]
assert a['participants']==['@me','@dara'] and a['category']=='Groceries'
assert ui.native_args('prepare_expense',{'amount':19.99},**ctx)['amountCents']==1999
for invalid in ('1.001','NaN','Infinity'):
    try:ui.exact_hundred(invalid)
    except ValueError:pass
    else:raise AssertionError('Invalid amount accepted: '+invalid)
many={'selectedExpenses':[dict(id='a',version=1),dict(id='b',version=4)]}
a=ui.native_args('propose_split',dict(mode='equal',participants=['@me','@dara']),many,[],'split')
assert 'transactionId' not in a and 'version' not in a,'Multiple records must never be guessed'
a=ui.native_args('propose_split',dict(transactionId='invented',mode='personal',participants=['@me']),**ctx)
assert 'version' not in a,'Unobserved ID must never acquire a guessed version'
a=ui.native_args('propose_split',dict(transactionId='observed',version=0,mode='personal',participants=['@me']),**ctx)
assert a['version']==0,'An explicit stale version must reach ledger rejection'
assert ui.native_args('save_user_fact',dict(text='A fact',personId='@dara'),**ctx)==dict(text='A fact',personId='@dara'),'Bookkeeping must not infer or alter scope'
a=ui.native_args('delete_saved_item',dict(kind='rule',id='saved'),summary,[{'items':[{'id':'saved','version':9}]}],'delete')
assert a['version']==9,'Saved-item versions must come from observed responses'
print('Bookkeeping boundary checks passed.')
