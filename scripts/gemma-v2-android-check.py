#!/usr/bin/env python3
"""Generate cross-language parity fixtures from the frozen experimental interface."""
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('interface', ROOT / 'scripts/gemma-v2-interface.py')
ui = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ui)
schemas = json.loads((ROOT / '.tools/finetune/gemma4-e2b-v2/tools.json').read_text())
policy = (ROOT / 'benchmarks/tool-calling/policy.txt').read_text()
single = {'selectedExpenses': [dict(id='observed', version=7, bankCategory='Groceries')]}
many = {'selectedExpenses': [dict(id='a', version=1), dict(id='b', version=4)]}
texts = ['Split this with @dara.', 'What do I owe?', 'Remember @dara is my roommate.',
         'Apply the saved trip template.', 'Archive the Colorado trip.',
         'Record a $19.99 cash purchase.', 'Find unfinished expenses and assign them to the trip.',
         'Save a recurring rule and rename this merchant.', 'Add new contact @dara.',
         'Received a repayment from @dara.', 'Forget the saved note.', 'Optimize redundant rules.']
views = [dict(text=text, summary=summary, expected=ui.schema_view(schemas, text, summary))
         for text in texts for summary in ({}, single, many)]
tests = [
    ('propose_split', dict(mode='percent', participants=['@me', '@dara'], shares=[12.34, 87.66]), single, []),
    ('prepare_expense', dict(amount=19.99), single, []),
    ('propose_split', dict(mode='equal', participants=['@me', '@dara']), many, []),
    ('propose_split', dict(transactionId='invented', mode='personal', participants=['@me']), single, []),
    ('propose_split', dict(transactionId='observed', version=0, mode='personal', participants=['@me']), single, []),
    ('save_user_fact', dict(text='A fact', personId='@dara'), single, []),
    ('delete_saved_item', dict(kind='rule', id='saved'), single, [dict(items=[dict(id='saved', version=9)])]),
    ('prepare_assignment', dict(transactionIds=['a', 'b'], tripId='trip'), many, []),
    ('request_clarification', dict(transactionId='observed', question='Which friend?'), single, []),
]
translations = [dict(name=name, arguments=args, summary=summary, responses=responses,
                     text='Divide this for @me and @dara.',
                     expected=ui.native_args(name, args, summary, responses, 'Divide this for @me and @dara.'))
                for name, args, summary, responses in tests]
dest = ROOT / 'android/assistant/src/test/resources/gemma-v2-parity.json'
dest.parent.mkdir(parents=True, exist_ok=True)
dest.write_text(json.dumps(dict(schemas=schemas, policy=policy, expectedPolicy=ui.policy_view(policy),
                                views=views, translations=translations), indent=2) + '\n')
print(f'Wrote {len(views)} schema and {len(translations)} argument parity fixtures.')
