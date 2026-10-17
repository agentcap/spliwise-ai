#!/usr/bin/env python3
"""Case-blind experimental tool selection and deterministic argument bookkeeping.

Only user messages, the supplied workspace summary, and prior tool responses are
inputs. This module never loads cases, expected answers, oracle calls or grades.
"""
import copy
from decimal import Decimal
import json
import re


def relevant_tools(text, selected=False):
    text = text.lower()
    names = {'finish_reply', 'request_clarification'}
    groups = {
        'propose_split': r'split|divid|allocat|portions?|shares?|half|halves|percent|%|personal|mine|belongs?|receipts?|purchases?|charges?',
        'search_transactions': r'find|search|locate|unfinished|receipts?|purchases?|charges?|expenses?',
        'lookup_context': r'rules?|polic|trips?|templates?|saved|remember|notes?|facts?|forget|erase|retire|archive|reopen',
        'save_rule': r'rules?|polic|recurr|ongoing|always|every|automati|future|whenever',
        'save_user_fact': r'remember|notes?|facts?|retain|context|access code|keep in mind|relationship|roommate|colleague|lives?|allerg|prefer',
        'delete_saved_item': r'delete|remove|erase|forget|retire|discard',
        'optimize_rules': r'optimi|deduplic|redundan|clean up|cleanup|consolidat',
        'manage_trip': r'trips?|destination|archive|reopen|vacation|journey',
        'add_person': r'new person|new contact|new colleague|add .*@|create .*person|introduce|register',
        'save_template': r'templates?|preset',
        'save_alias': r'alias|display|merchant name|label|rename|readable|call .* as|show .* as',
        'prepare_assignment': r'assign|attach|detach|membership|place .*in|move .*trip|remove .*trip',
        'prepare_expense': r'cash|manual|out.of.pocket|expense card|purchase card|record .*paid|spent',
        'prepare_repayment': r'repay|paid me|received|sent me|return .*credit|credit .*return|refund .*credit',
    }
    for name, pattern in groups.items():
        if re.search(pattern, text):
            names.add(name)
    if selected:
        names.add('propose_split')
        # Selected records are already visible; don't expose an unnecessary read.
        if not re.search(r'find|search|locate|unfinished|workspace|outside', text):
            names.discard('search_transactions')
    return names


def policy_view(policy):
    policy = policy.replace('Amounts are USD integer cents.',
        'Workspace amounts are USD integer cents. In tools enter amount in dollars, and shares in dollars for exact mode or percentages for percent mode.')
    policy = policy.replace('exact values are cents; percent values are basis points totaling 10000.',
        'For tools use shares in dollars for exact mode, or percentages totaling 100 for percent mode.')
    policy = policy.replace('Omit values for personal/equal.', 'Omit shares for personal/equal.')
    policy = policy.replace('propose_split requires a real ID and current version.',
        'propose_split requires a real ID, unless exactly one expense is selected. The application supplies current versions from visible records.')
    policy += ('\nExperimental interface: version and versions are supplied by the application from records already shown to you. '
        'Never guess an ID. You may use exact @handles for people. Use amount (dollars) instead of amountCents, and shares instead of values. '
        'The application converts units and the ledger calculates equal/percentage allocations. '
        'For propose_split, category defaults to the visible expense category and explanation defaults to your latest user instruction. '
        'Choose the requested people, scope, action, and finish outcome yourself. Only exposed tools are available.')
    return policy


def schema_view(schemas, text, summary):
    keep = relevant_tools(text, bool(summary.get('selectedExpenses')))
    result = []
    for original in schemas:
        if original['name'] not in keep:
            continue
        row = copy.deepcopy(original)
        p = row['parameters']; props = p['properties']
        for field in ('version', 'versions'):
            props.pop(field, None)
            p['required'] = [k for k in p.get('required', []) if k != field]
        if 'amountCents' in props:
            props.pop('amountCents')
            props['amount'] = {'type': 'number', 'description': 'USD dollars, for example 12.34.'}
            p['required'] = ['amount' if k == 'amountCents' else k for k in p['required']]
        if 'values' in props:
            props.pop('values')
            props['shares'] = {'type':'array', 'items':{'type':'number'},
                'description':'Parallel to participants: USD dollars in exact mode; percentages totaling 100 in percent mode. Omit for equal/personal.'}
        if row['name'] in ('search_transactions', 'lookup_context'):
            p['required'] = [k for k in p['required'] if k != 'offset']
        if row['name'] == 'propose_split':
            p['required'] = [k for k in p['required'] if k not in ('category','explanation')]
            if len(summary.get('selectedExpenses') or []) == 1:
                p['required'] = [k for k in p['required'] if k != 'transactionId']
        row['description'] = (row['description'].replace('Values are integer cents for exact mode, basis points totaling 10000 for percent.',
            'Use shares in dollars for exact mode or percentages totaling 100 for percent mode.')
            .replace('Use the latest expense version.', 'The application supplies the observed current version.')
            .replace('transactionIds and versions must be parallel arrays from the ledger.', 'Use transactionIds from the visible ledger; the application supplies their versions.')
            .replace('using its latest ID and version from lookup_context.', 'using its ID from lookup_context; the application supplies its observed version.'))
        result.append(row)
    return result


def observed_records(summary, responses):
    records = {}
    def walk(x):
        if isinstance(x, dict):
            if isinstance(x.get('id'), str) and isinstance(x.get('version'), int):
                records[x['id']] = x
            for v in x.values(): walk(v)
        elif isinstance(x, list):
            for v in x: walk(v)
    walk(summary)
    for x in responses: walk(x)
    return records


def exact_hundred(value):
    d = Decimal(str(value)) * 100
    if not d.is_finite() or d != d.to_integral_value():
        raise ValueError('Amounts and percentages must have at most two decimal places')
    return int(d)


def native_args(name, arguments, summary, responses, user_text):
    """Translate only unambiguous bookkeeping; never infer requested semantics."""
    a = copy.deepcopy(arguments)
    records = observed_records(summary, responses)
    if 'amount' in a:
        if 'amountCents' in a: raise ValueError('Use only amount, not amountCents')
        a['amountCents'] = exact_hundred(a.pop('amount'))
    if 'shares' in a:
        if a.get('mode') not in ('percent', 'exact'): raise ValueError('shares requires exact or percent mode')
        if 'values' in a: raise ValueError('Use only shares, not values')
        a['values'] = [exact_hundred(v) for v in a.pop('shares')]
    if name in ('search_transactions', 'lookup_context'):
        a.setdefault('offset', 0)
    if name == 'propose_split':
        selected = summary.get('selectedExpenses') or []
        if not a.get('transactionId') and len(selected) == 1:
            a['transactionId'] = selected[0]['id']
        record = records.get(a.get('transactionId'))
        if record:
            a.setdefault('version', record['version'])
            a.setdefault('category', record.get('bankCategory') or record.get('category') or '')
        a.setdefault('explanation', user_text)
    if name == 'request_clarification' and a.get('transactionId') in records:
        a.setdefault('version', records[a['transactionId']]['version'])
    if a.get('id') in records:
        a.setdefault('version', records[a['id']]['version'])
    if name == 'prepare_assignment' and 'versions' not in a:
        ids = a.get('transactionIds', [])
        if ids and all(k in records for k in ids):
            a['versions'] = [records[k]['version'] for k in ids]
    return a


def model_args(name, arguments, summary):
    """Convert validated native targets to the reduced model-facing contract."""
    a = copy.deepcopy(arguments)
    a.pop('version', None); a.pop('versions', None)
    if 'amountCents' in a: a['amount'] = a.pop('amountCents') / 100
    if 'values' in a: a['shares'] = [v / 100 for v in a.pop('values')]
    if name in ('search_transactions', 'lookup_context') and a.get('offset') == 0:
        a.pop('offset')
    if name == 'propose_split':
        a.pop('explanation', None)
        if len(summary.get('selectedExpenses') or []) == 1:
            a.pop('transactionId', None)
    return a


def request_view(body, reduced):
    body = copy.deepcopy(body)
    if not reduced: return body, {}
    policy, raw_summary = body['instructions'].split('\nCurrent workspace summary: ', 1)
    summary = json.loads(raw_summary)
    user_text = '\n'.join(r.get('content','') for r in body['input'] if r.get('role') == 'user')
    responses = [json.loads(r['output']) for r in body['input'] if r.get('type') == 'function_call_output']
    body['instructions'] = policy_view(policy) + '\nCurrent workspace summary: ' + raw_summary
    body['tools'] = schema_view(body['tools'], user_text, summary)
    for r in body['input']:
        if r.get('type') == 'function_call':
            r['arguments'] = json.dumps(model_args(r['name'], json.loads(r['arguments']), summary))
    return body, dict(summary=summary, responses=responses, user_text=user_text)
