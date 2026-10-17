#!/usr/bin/env python3
"""Run and score the app's shared tool-calling contract on hosted or local models."""
import argparse
import collections
import hashlib
import html
import json
import math
import os
from pathlib import Path
import platform
import re
import statistics
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent.parent
BENCH = ROOT / "benchmarks/tool-calling"
DEFAULT_OUTPUT = ROOT / ".tools/benchmarks/tool-calling"
RUBRIC = json.loads((BENCH / "rubric-audit.json").read_text())


def argument_errors(value, schema, path="arguments"):
    """Validate the types, enums and required fields used in this app's catalog."""
    kind=schema.get("type")
    valid={"object": isinstance(value,dict), "array": isinstance(value,list),
           "string": isinstance(value,str), "integer": isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value) and int(value)==value,
           "number": isinstance(value,(int,float)) and not isinstance(value,bool), "boolean": isinstance(value,bool)}
    if kind in valid and not valid[kind]:
        return [f"{path}: expected {kind}"]
    errors=[]
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: invalid enum")
    if kind=="object":
        errors += [f"{path}.{k}: missing" for k in schema.get("required",[]) if k not in value]
        for k,v in value.items():
            if k in schema.get("properties",{}):
                errors += argument_errors(v,schema["properties"][k],f"{path}.{k}")
    if kind=="array":
        for i,v in enumerate(value):
            errors += argument_errors(v,schema.get("items",{}),f"{path}[{i}]")
    return errors


def matches(actual, expected):
    """Partial objects; exact unordered arrays with one-to-one matching.

    This intentionally accepts valid call ordering and extra descriptive fields,
    but rejects extra actions, omitted participants, incorrect cents and scopes.
    """
    if isinstance(expected, dict):
        if "$oneOf" in expected:
            return any(matches(actual, v) for v in expected["$oneOf"])
        if "participants" in expected and "values" in expected:
            if not isinstance(actual, dict) or not isinstance(actual.get("values"),list):
                return False
            if len(actual.get("participants",[])) != len(actual["values"]):
                return False
            if len(actual.get("participants", [])) != len(set(actual.get("participants", []))):
                return False
            if dict(zip(actual.get("participants", []),actual["values"])) != dict(zip(expected["participants"],expected["values"])):
                return False
            return all(k in actual and matches(actual[k],v) for k,v in expected.items() if k not in ("participants","values"))
        if "merchant" in expected and "split" in expected and isinstance(actual,dict):
            if any(actual.get(k) and k not in expected for k in ("from","to","accountId","category")):
                return False
            if actual.get("merchantAliases") and "merchantAliases" not in expected:
                return False
        return isinstance(actual, dict) and all(k in actual and matches(actual[k], v) for k, v in expected.items())
    if isinstance(expected, list):
        if not isinstance(actual, list) or len(actual) != len(expected):
            return False
        # Backtracking avoids a greedy partial-object match hiding a valid match.
        def assign(items, remaining):
            if not items:
                return True
            return any(matches(candidate, items[0]) and assign(items[1:], remaining[:i] + remaining[i+1:])
                       for i, candidate in enumerate(remaining))
        return assign(expected, actual)
    if isinstance(expected, str):
        return isinstance(actual, str) and actual.casefold() == expected.casefold()
    return type(actual) is type(expected) and actual == expected


def grade(row, audited=True, schemas=None):
    expected = row["expect"]
    plan = row["plan"]
    failures = []
    reply=row.get("reply","")
    raw_control='<|"|>' in reply or reply.lstrip().startswith(("finish_reply{","finish_reply("))
    if raw_control and not any(plan.get(k) for k in ("organization","requests","updates")):
        failures.append("malformed_final_response")
    if row.get("error") or not row.get("committed"):
        failures.append("runtime_or_commit")
    if not row.get("financialStateUnchanged"):
        failures.append("financial_state_changed")
    for kind in ("organization", "requests", "updates"):
        actual = plan.get(kind, [])
        optional = RUBRIC["optionalFacts"].get(row.get("caseId")) if audited else None
        if kind == "organization" and optional:
            def allowed_fact(o):
                return (o.get("kind")=="context" and optional["quote"] in o.get("quote","")
                        and all(t.casefold() in o.get("text","").casefold() for t in optional["textContains"])
                        and all(not o.get(k) for k in ("tripId","from","to"))
                        and o.get("personId") in (None,"","self"))
            actual = [o for o in actual if not allowed_fact(o)]
        # A genuine clarification can carry an Inbox question without a split.
        if kind == "updates" and expected.get("question"):
            actual = [u for u in actual if u.get("state") != "inbox" or u.get("proposal")]
        if not matches(actual, expected[kind]):
            failures.append(kind)
    if expected.get("question"):
        text = row.get("reply", "") + " ".join(u.get("attention", "") for u in plan.get("updates", []))
        explicit_question=any(t.get("name")=="request_clarification" and not t.get("response",{}).get("error")
                              and t.get("arguments",{}).get("question","").strip() for t in row.get("trace",[]))
        if "?" not in text and not explicit_question:
            failures.append("missing_question")
    for fragment in expected.get("answerContains", []):
        reply=row.get("reply", "")
        numeric=re.search(r"(?<![\d.])"+re.escape(fragment)+r"(?:\.00)?(?!\d|\.\d)",reply)
        verbal_zero=fragment=="0" and re.search(r"\b(?:owes? nothing|(?:does not|doesn't|doesn’t) owe (?:anything|any money)|(?:has |have )?no (?:outstanding |unpaid )?(?:balance|debt)|zero (?:balance|dollars))\b",reply,re.I)
        verbal_six=fragment=="6" and re.search(r"\bsix dollars\b",reply,re.I)
        if not (numeric or verbal_zero or verbal_six):
            failures.append("answer")
    for fragment in expected.get("contextTextContains", []):
        if not any(fragment.casefold() in o.get("text", "").casefold() for o in plan.get("organization",[]) if o.get("kind")=="context"):
            failures.append("fact_content")
    if expected.get("quoteRequired") and any(not o.get("quote") for o in plan.get("organization", []) if o.get("kind") == "context"):
        failures.append("missing_quote")
    if not any(plan.get(k) for k in ("organization","requests","updates")) and re.search(r"\bI(?:'ve| have)?\s+(?:successfully\s+)?(?:saved|created|added|recorded|updated|deleted|archived|prepared|staged|finalized|sent|charged|converted|approved|reopened)\b",row.get("reply",""),re.I):
        failures.append("unsupported_success_claim")
    errors = [t for t in row.get("trace", []) if t.get("response", {}).get("error")]
    protocol=[]
    if schemas is not None:
        for t in row.get("trace",[]):
            schema=schemas.get(t["name"])
            protocol += (["unknown/malformed tool"] if schema is None else argument_errors(t.get("arguments"),schema["parameters"]))
    return dict(passed=not failures, failures=failures, toolErrors=len(errors),
                argumentErrors=protocol,unparsedControlResponse=raw_control,
                firstPass=not failures and not errors and not protocol and not raw_control,
                rejectedCalls=[t["name"] for t in errors])


def percentile(values, p):
    if not values:
        return None
    values = sorted(values)
    at = (len(values)-1)*p
    a, b = math.floor(at), math.ceil(at)
    return values[a] + (values[b]-values[a])*(at-a)


def wilson(k, n):
    if not n:
        return [0, 0]
    z=1.96; p=k/n; d=1+z*z/n
    center=(p+z*z/(2*n))/d
    margin=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d
    return [center-margin, center+margin]


def run(args):
    out = Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["TOOL_BENCH_REASONING"]=args.reasoning
    env["TOOL_BENCH_MAX_OUTPUT"]=str(args.max_output)
    env["TOOL_BENCH_BACKEND"]=args.backend
    env["TOOL_BENCH_ACTIVATION"]=args.activation
    if args.backend != "cpu" and not args.model.startswith("e"):
        raise SystemExit("GPU backend applies only to local models")
    if args.activation != "default" and not args.model.startswith("e"):
        raise SystemExit("Activation precision applies only to local models")
    if args.model.startswith("e") and (args.reasoning!="none" or args.max_output!=1024):
        raise SystemExit("Local baseline uses the fixed app sampler and 1024-token cap")
    # Parse only the needed key; never source arbitrary shell text or print secrets.
    if args.model == "gpt-6-luna" and not env.get("OPENAI_API_KEY"):
        path = ROOT / ".env.local"
        if path.exists():
            for line in path.read_text().splitlines():
                if line.startswith("OPENAI_API_KEY="):
                    env["OPENAI_API_KEY"] = line.split("=", 1)[1].strip().strip("\"'")
    if args.model == "gpt-6-luna" and not env.get("OPENAI_API_KEY"):
        raise SystemExit("OPENAI_API_KEY is not configured")
    java = Path(args.java) if args.java else ROOT / ".tools/android/jdk21/bin/java"
    libs = ROOT / "android/model-check/build/install/model-check/lib"
    run_name = args.model if args.reasoning=="none" and args.max_output==1024 else f"{args.model}-{args.reasoning}-{args.max_output}"
    if args.backend != "cpu":
        run_name += f"-{args.backend}"
    if args.activation != "default":
        run_name += f"-{args.activation}"
    target = out / f"{run_name}.jsonl"
    dataset_hash = hashlib.sha256(Path(args.dataset).read_bytes()).hexdigest()
    policy_hash = hashlib.sha256((BENCH / "policy.txt").read_bytes()).hexdigest()
    if target.exists():
        previous = [json.loads(l) for l in target.read_text().splitlines() if l.strip()]
        if any(r.get("datasetHash") != dataset_hash for r in previous):
            raise SystemExit("Refusing to mix different datasets; choose a new output directory")
        old_manifest = out / f"{run_name}.manifest.json"
        if old_manifest.exists():
            old=json.loads(old_manifest.read_text())
            if old.get("policySha256") != policy_hash:
                raise SystemExit("Refusing to mix different policies; choose a new output directory")
            if args.model.startswith("e") and (old.get("backend", "cpu") != args.backend or old.get("activationDataType", "default") != args.activation):
                raise SystemExit("Refusing to mix backends or precision settings; choose a new output directory")
    compiled_runner=Path(args.runner_jar).resolve() if args.runner_jar else libs / "model-check.jar"
    classpath=(str(compiled_runner)+os.pathsep if args.runner_jar else "")+str(libs / "*")
    command = [str(java), "-Xmx1g", "-cp", classpath, "com.splitwiseai.check.ModelCheckKt", "--benchmark",
               str(ROOT), str(Path(args.dataset).resolve()), args.model, str(target), args.filter]
    manifest = dict(model=args.model, command=[s for s in command], timestamp=time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),
                    platform=platform.platform(), cpu=platform.processor(), policySha256=policy_hash,
                    datasetSha256=dataset_hash,
                    runnerSha256=hashlib.sha256((ROOT/"android/model-check/src/main/kotlin/com/splitwiseai/check/ToolBenchmark.kt").read_bytes()).hexdigest(),
                    scoringSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                    compiledRunnerSha256=hashlib.file_digest(compiled_runner.open("rb"),"sha256").hexdigest(),
                    backend=args.backend if args.model.startswith("e") else "hosted",
                    activationDataType=args.activation if args.model.startswith("e") else None,
                    localSampler=dict(topK=10,topP=.9,temperature=.2,seed=0) if args.model.startswith("e") else None,
                    cpuThreads=6 if args.model.startswith("e") and args.backend=="cpu" else None, reasoning="disabled" if args.model.startswith("e") else args.reasoning,
                    limits=dict(turns=6, outputTokensPerTurn=args.max_output, scenarioTimeoutSeconds=120),
                    latency="scenario wall time including tool execution, excluding one-time engine load; firstTurnMs is not TTFT",
                    runtime="Production ledger oracle; no inference" if args.model=="oracle" else f"LiteRT-LM 0.18.0 JVM {args.backend.upper()}" if args.model.startswith("e") else "OpenAI Responses API",
                    hardware="Intel Core i7-14700F; RTX 4070 12 GB; no physical phone benchmark" if args.backend=="gpu" else f"Intel Core i7-14700F; {platform.system()}; no physical phone benchmark")
    models = json.loads((ROOT / "android/app/src/main/assets/models.json").read_text())
    if args.model.startswith("e"):
        model = next(m for m in models if m["id"] == args.model)
        path = ROOT / ".tools/android/models" / model["filename"]
        digest = hashlib.file_digest(path.open("rb"),"sha256").hexdigest()
        if digest != model["sha256"]:
            raise SystemExit("Model checksum mismatch")
        manifest["modelArtifact"] = model
        manifest["verifiedSha256"] = digest
    (out / f"{run_name}.manifest.json").write_text(json.dumps(manifest,indent=2)+"\n")
    with (out / f"{run_name}.log").open("a") as log:
        process = subprocess.Popen(command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
        print(f"Benchmark started: {args.model}; pid={process.pid}; results={target}", flush=True)
        code = process.wait()
    print(f"Benchmark finished: {args.model}; exit={code}",flush=True)
    return code


def report(args):
    out = Path(args.output).resolve()
    dataset = json.loads(Path(args.dataset).read_text())
    expected_ids = {c["id"] for c in dataset["cases"]}
    schemas={t["name"]:t for t in json.loads((out/"tools.json").read_text())}
    memory_path=out/"memory.json"
    memory=json.loads(memory_path.read_text()) if memory_path.exists() else {}
    models = {}
    rows_by_model = {}
    contracts=set()
    for path in sorted(out.glob("*.jsonl")):
        if path.stem == "oracle":
            continue
        rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        if not rows:
            continue
        if len({r["caseId"] for r in rows}) != len(rows):
            raise ValueError(f"Duplicate case results: {path}")
        if len({r["contractHash"] for r in rows}) != 1:
            raise ValueError(f"Mixed tool contracts: {path}")
        contracts.update(r["contractHash"] for r in rows)
        if any(r["datasetHash"] != hashlib.sha256(Path(args.dataset).read_bytes()).hexdigest() for r in rows):
            raise ValueError("Dataset differs from results; start a fresh output directory")
        all_graded = [dict(r, grade=grade(r,schemas=schemas), strictGrade=grade(r,audited=False,schemas=schemas), excluded=r["caseId"] in RUBRIC["excludedCases"]) for r in rows]
        rows_by_model[path.stem] = all_graded
        graded = [r for r in all_graded if not r["excluded"]]
        if not graded:
            raise ValueError(f"No eligible scored cases in {path}")
        raw_total = len(rows)
        rows = [r for r in rows if r["caseId"] not in RUBRIC["excludedCases"]]
        total=len(rows); passed=sum(r["grade"]["passed"] for r in graded)
        hosted=path.stem.startswith("gpt-")
        latency=[r["elapsedMs"]/1000 for r in rows]
        by_category={}
        for category in sorted({r["category"] for r in rows}):
            subset=[r for r in graded if r["category"] == category]
            by_category[category]=dict(passed=sum(r["grade"]["passed"] for r in subset), total=len(subset),
                                      medianSeconds=statistics.median(r["elapsedMs"]/1000 for r in subset))
        manifest_path=out / f"{path.stem}.manifest.json"
        settings=json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
        models[path.stem]=dict(reasoning=settings.get("reasoning"),outputTokenCap=settings.get("limits",{}).get("outputTokensPerTurn"),
            backend=settings.get("backend", "hosted" if hosted else "cpu"),activationDataType=settings.get("activationDataType","default"),runtime=settings.get("runtime"),hardware=settings.get("hardware"),
            total=total, rawTested=raw_total, rawStrictPassed=sum(r["strictGrade"]["passed"] for r in all_graded),
            excludedCases=[r["caseId"] for r in all_graded if r["excluded"]], passed=passed, successRate=passed/total, wilson95=wilson(passed,total),
            familyMacroSuccess=statistics.mean(statistics.mean(r["grade"]["passed"] for r in graded if r["family"]==f) for f in {r["family"] for r in graded}),
            firstPass=sum(r["grade"]["firstPass"] for r in graded),
            coverage=len({r["caseId"] for r in all_graded}&expected_ids)/len(expected_ids),
            medianSeconds=statistics.median(latency), p95Seconds=percentile(latency,.95),
            successfulMedianSeconds=statistics.median([r["elapsedMs"]/1000 for r in graded if r["grade"]["passed"]]) if passed else None,
            toolErrors=sum(r["grade"]["toolErrors"] for r in graded),
            argumentSchemaErrors=sum(len(r["grade"]["argumentErrors"]) for r in graded),
            unparsedControlResponses=sum(r["grade"]["unparsedControlResponse"] for r in graded),
            nativeSdkParseFailureCases=sum("parse tool" in (r.get("error") or "").lower() for r in all_graded),
            toolCalls=sum(t["name"] in schemas for r in all_graded for t in r.get("trace",[])),
            byTool={name:dict(calls=sum(t["name"]==name for r in all_graded for t in r.get("trace",[])),
                             rejected=sum(t["name"]==name and bool(t.get("response",{}).get("error")) for r in all_graded for t in r.get("trace",[]))) for name in schemas},
            noFinancialMutation=all(r["financialStateUnchanged"] for r in rows),
            tokenUsageAvailable=hosted,
            inputTokens=sum(r["inputTokens"] for r in all_graded) if hosted else None,
            cachedInputTokens=sum(r["cachedInputTokens"] for r in all_graded) if hosted else None,
            outputTokens=sum(r["outputTokens"] for r in all_graded) if hosted else None,
            # Verified 2026-10-16 GPT-6 Luna token prices, no cache discount assumed.
            estimatedUncachedCostUsd=sum((r["inputTokens"]*.1 + r["outputTokens"]*.5)/1_000_000 for r in all_graded) if hosted else None,
            loadMs=rows[0]["loadMs"], byCategory=by_category,
            failures=[dict(caseId=r["caseId"], reasons=r["grade"]["failures"], error=r.get("error"), rejectedCalls=r["grade"]["rejectedCalls"]) for r in graded if not r["grade"]["passed"]])
    if len(contracts)>1:
        raise ValueError("Models used different datasets, policies or tool definitions; choose comparable runs")
    common = set.intersection(*(set(r["caseId"] for r in rows if not r["excluded"]) for rows in rows_by_model.values())) if rows_by_model else set()
    paired={}
    names=list(rows_by_model)
    for i, a in enumerate(names):
        for b in names[i+1:]:
            aa={r["caseId"]: r["grade"]["passed"] for r in rows_by_model[a] if not r["excluded"]}; bb={r["caseId"]: r["grade"]["passed"] for r in rows_by_model[b] if not r["excluded"]}
            both=aa.keys()&bb.keys()
            paired[f"{a} vs {b}"]=dict(n=len(both), onlyA=sum(aa[k] and not bb[k] for k in both), onlyB=sum(bb[k] and not aa[k] for k in both), bothPass=sum(aa[k] and bb[k] for k in both))
    complete=all(name in models for name in ("e2b","e4b","gpt-6-luna")) and all(m["rawTested"]==len(expected_ids) and m["coverage"]==1 for m in models.values())
    summary=dict(complete=complete,scoringSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        rubricSha256=hashlib.sha256((BENCH/"rubric-audit.json").read_bytes()).hexdigest(),
        datasetCases=len(expected_ids), eligibleCases=len(expected_ids)-len(RUBRIC["excludedCases"]), rubricAudit=RUBRIC,localMemory=memory,
        families=len({c["family"] for c in dataset["cases"]}), commonCases=len(common), models=models, paired=paired)
    summary["costRates"]=dict(currency="USD",inputPerMillion=.10,outputPerMillion=.50,cacheDiscountApplied=False,verifiedOn="2026-10-16",scope="Retained hosted runs only; discarded pilots are additional")
    summary["datasetSha256"]=hashlib.sha256(Path(args.dataset).read_bytes()).hexdigest()
    summary["contractHashes"]=sorted(contracts)
    focused_path=out/"focused-gpu/summary.json"
    focused=json.loads(focused_path.read_text()) if focused_path.exists() else {}
    summary["focusedAppPath"]=focused
    (out / "summary.json").write_text(json.dumps(summary,indent=2)+"\n")
    lines=["# Splitwise AI tool-calling benchmark", "", "All model/configuration runs are complete." if complete else "**RUN IN PROGRESS — model coverage is incomplete.**", "", f"Frozen dataset: {len(expected_ids)} scenarios in {summary['families']} families; {summary['eligibleCases']} eligible for headline scoring after fixture audit. Results are measured on synthetic ledgers. Each case is one trial; variants in a family are correlated.", "",
           "| Model | Pass / tested | Coverage | Success | 95% Wilson interval | Median | p95 | Tool errors |",
           "| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |"]
    for name,m in models.items():
        lo,hi=m["wilson95"]
        lines.append(f"| {name} | {m['passed']}/{m['total']} | {m['coverage']:.0%} | {m['successRate']:.1%} | {lo:.1%}–{hi:.1%} | {m['medianSeconds']:.2f}s | {m['p95Seconds']:.2f}s | {m['toolErrors']} |")
    lines += ["", "Latency summaries include failed tasks; fast failures do not establish useful speed. Suffix -gpu means the runtime's default GPU activation precision, while -gpu-float32 explicitly requests FLOAT32 activations with the same quantized weights. Precision profiles use separate compiled caches. The FLOAT32 profile was added after observing default GPU errors and a small diagnostic; this is an exploratory configuration comparison on the same suite, not a held-out evaluation or proof of a particular internal runtime defect."]
    lines += ["", "## Method and limits", "", "All models receive the same full 16-tool Android catalog, policy, logical synthetic workspace and conversation history. The baseline trio permits up to six inference rounds, 1,024 output tokens per round and 120 seconds per case. The additional GPT-6 Luna medium/4096 configuration keeps the same scenarios, tools, turn and time limits, with reasoning enabled and a larger output allowance closer to the web app's default. It is a separate budget comparison. The common runner dispatches calls through the production ledger validators and stops on a final response or clarification. There are no model-specific prompt retries, focused routing shortcuts or application guards that bypass inference. This isolates model tool use; it is not a score of the web app's different tool schemas or its full production orchestration.", "",
        "A pass requires exact action counts, correct target IDs and versions where specified, participants, integer-cent allocations, categories when specified, requested scopes, valid commit, and no transaction or repayment mutation before confirmation. Clarification cases require a question and prohibit ready splits or organization changes. Harmless read calls and differing call/participant ordering are accepted. Failed tool calls recovered within the limit can pass; the first-pass count excludes those recoveries. Rejected unsafe calls are counted separately and do not imply a ledger change.", "",
        "Gemma uses the app's pinned LiteRT-LM 0.18.0 artifacts with thinking disabled, temperature 0.2 and speculative decoding. Unsuffixed e2b/e4b runs use six desktop CPU threads under WSL2. The -gpu runs use native Windows Java and WebGPU/Direct3D on the RTX 4070 12 GB; GPU initialization failure stops the run without a CPU fallback. Different backends can produce different sampled outputs, so GPU accuracy is measured again. GPT-6 Luna uses Responses with the reasoning setting shown in its run name/manifest and default API sampling. Local timings describe this desktop, not phone GPU/NPU performance. Total scenario wall time includes inference, subsequent tool turns, validation and commit; one-time engine initialization is separate. firstTurnMs is completion of the first inference turn, not first-token latency. No local token/s or energy estimate is inferred. Fixtures contain four initial people and at most 22 expenses; full statement and long-history scaling remain unmeasured.", "",
        "Token cost is an uncached estimate using GPT-6 Luna's documented $0.10 input / $0.50 output per million tokens, including billed output/reasoning tokens. API usage records are preserved; cached input is recorded but no discount assumed. Local API charge is zero; electricity, hardware, download and deployment costs were not measured. [OpenAI model documentation](https://developers.openai.com/api/docs/models/gpt-6-luna), [Gemma function calling](https://ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4).", "",
        "The fixed rubric audit excludes personal-04 for a mismatched merchant fixture and accepts the optional exact office-food fact in web-rule-03. The same corrections apply to every model; raw strict scores and all 141 traces remain available. Unchanged balances establish the dispatcher boundary, not that a model never attempted a rejected action. Initial hosted protocol-pilot results were discarded after fixing token accounting for truncated arguments; the retained run uses unchanged prompts and limits.", "",
        "## Category results", "", "| Category | " + " | ".join(models) + " |", "| --- | " + " | ".join("---:" for _ in models) + " |"]
    for category in sorted({c["category"] for c in dataset["cases"]}):
        entries=[]
        for m in models.values():
            c=m["byCategory"].get(category)
            entries.append(f"{c['passed']}/{c['total']}" if c else "unmeasured")
        lines.append("| " + category + " | " + " | ".join(entries) + " |")
    lines += ["", "## Observed tool calls", "", "Cells show rejected calls / total parsed calls, including the excluded fixture. This is a diagnostic count, not an independent tool accuracy score: wrong but accepted arguments are caught by the task grader. Required fields, types and enums are also checked on parsed calls; their error totals are in summary.json.", "",
              "| Tool | " + " | ".join(models) + " |", "| --- | " + " | ".join("---:" for _ in models) + " |"]
    for tool_name in schemas:
        lines.append("| "+tool_name+" | "+" | ".join(f"{m['byTool'][tool_name]['rejected']} / {m['byTool'][tool_name]['calls']}" for m in models.values())+" |")
    lines += ["", "## Protocol diagnostics", "", "Task success and schema compliance are separate. The production dispatcher accepts some omitted fields using defaults; these can complete the task while still violating the declared schema. First-pass success requires a correct task without rejected calls, argument-schema errors or raw unparsed control output. No extra retry budget is added.", "",
              "| Model | First-pass tasks | Argument-schema errors | Unparsed control replies | Native SDK parse failures |", "| --- | ---: | ---: | ---: | ---: |"]
    for name, m in models.items():
        lines.append(f"| {name} | {m['firstPass']}/{m['total']} | {m['argumentSchemaErrors']} | {m['unparsedControlResponses']} | {m['nativeSdkParseFailureCases']} |")
    gpu_paths=sorted(out.glob("gpu*-telemetry.json"))
    if gpu_paths:
        lines += ["", "## GPU evidence", "", "Native Windows GPU runs request Backend.GPU directly and cannot fall back to CPU. The portable Java and Microsoft shader compiler binaries are fingerprinted in gpu-telemetry.json. These samples cover the whole graphics card, including the desktop and other applications; memory peaks are not per-model VRAM requirements. Startup reads model files through the WSL share and is not a phone cold-start measurement.", "",
                  "| Run | Device | Samples | Peak GPU use | Peak whole-device memory |", "| --- | --- | ---: | ---: | ---: |"]
        for gpu_path in gpu_paths:
            gpu=json.loads(gpu_path.read_text())
            for name, record in gpu.get("runs",{}).items():
                samples=record.get("samples",[])
                if samples:
                    peak=max(float(s["gpuPercent"]) for s in samples)
                    mem=max(float(s["deviceMemoryMiB"]) for s in samples)
                    lines.append(f"| {name} | {samples[0]['device']} | {len(samples)} | {peak:.0f}% | {mem/1024:.2f} GiB |")
    if memory:
        lines += ["", "## Desktop memory", "", "Linux process-lifetime RSS peaks for the local inference JVM, including native allocations and mapped model pages. These are observations on this computer, not phone RAM requirements or GPU memory measurements. File sizes are pinned download sizes; they are distinct from runtime memory.", "",
                  "| Model | Model file | Desktop peak RSS |", "| --- | ---: | ---: |"]
        for name, record in memory.items():
            manifest_path=out/f"{name}.manifest.json"
            manifest=json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
            size=manifest.get("modelArtifact",{}).get("size")
            lines.append(f"| {name} | {size/1e9:.2f} GB | {record['peakRssBytes']/2**30:.2f} GiB |")
        lines += ["", "Engine initialization is excluded from scenario latency and is recorded in each manifest/result. It follows checksum verification and may use warmed file/kernel caches; it is not an OS-cold startup measurement. Fixture creation is also outside the timed request interval."]
    if focused:
        lines += ["", "## Existing app equal-split path", "", "Separate narrow check: eight repeats per model of a selected $12 lunch split equally between self and Alex, explicitly categorized Food & Drink. This calls the actual Android InferenceSession with its five-tool focus and early candidate validation. It uses the app's default GPU precision, with the actual backend checked on every trial. These are repeated trials of one request, not additional independent accuracy cases, and are not pooled into the full-catalog score. The first request includes engine initialization with warmed model files; warm timings cover the remaining requests, including any failures.", "",
                  "| Model | Passed | First request | Warm median | Warm range | Backend |", "| --- | ---: | ---: | ---: | --- | --- |"]
        for name, f in focused.items():
            lines.append(f"| {name} | {f['passed']}/{f['trials']} | {f['firstRequestSeconds']:.2f}s | {f['warmMedianSeconds']:.2f}s | {f['warmMinSeconds']:.2f}–{f['warmMaxSeconds']:.2f}s | {f['backend']} |")
    for name,m in models.items():
        lines += ["", f"## {name}: failures", ""]
        lines += [f"- `{f['caseId']}`: {', '.join(f['reasons'])}" + (f"; {f['error']}" if f['error'] else "") for f in m["failures"]] or ["None."]
        if name.startswith("gpt-"):
            lines += ["", f"Input tokens: {m['inputTokens']:,}; cached: {m['cachedInputTokens']:,}; output: {m['outputTokens']:,}. Estimated uncached cost: ${m['estimatedUncachedCostUsd']:.4f}."]
    (out / "report.md").write_text("\n".join(lines)+"\n")
    # Portable review artifact; no external libraries, network requests or secrets.
    headline='<p>'+('All six primary configurations completed.' if complete and len(models)==6 else 'All recorded configurations completed.' if complete else 'Run in progress: partial results below are provisional.')+'</p>'
    headline+='<table><thead><tr><th>Configuration</th><th>Passed</th><th>Success</th><th>Median</th><th>p95</th></tr></thead><tbody>'
    for name,m in models.items():
        headline+=f"<tr><td>{html.escape(name)}</td><td>{m['passed']}/{m['total']}</td><td>{m['successRate']:.1%}</td><td>{m['medianSeconds']:.2f}s</td><td>{m['p95Seconds']:.2f}s</td></tr>"
    headline+='</tbody></table><h2>Inspect each request</h2>'
    table_rows=[]
    prompts={c["id"]: c["prompt"] for c in dataset["cases"]}
    for name, rows in rows_by_model.items():
        for r in rows:
            status="excluded" if r["excluded"] else "pass" if r["grade"]["passed"] else "fail"
            detail=json.dumps(dict(error=r.get("error"),rounds=r.get("rounds"),loadMs=r.get("loadMs"),reply=r["reply"],plan=r["plan"],expected=r["expect"],trace=r["trace"],grade=r["grade"]),indent=2)
            table_rows.append(f'<tr data-search="{html.escape((name+" "+r["category"]+" "+r["caseId"]+" "+status).lower())}"><td>{html.escape(name)}</td><td>{html.escape(r["caseId"])}</td><td class="{status}">{status}</td><td>{r["elapsedMs"]/1000:.2f}s</td><td><details><summary>{html.escape(prompts[r["caseId"]])}</summary><pre>{html.escape(detail)}</pre></details></td></tr>')
    page='''<!doctype html><html><meta charset="utf-8"><title>Splitwise tool benchmark</title><style>body{font:15px system-ui;background:#0c1425;color:#e7ecf6;margin:32px}h1{font-size:28px}input{padding:12px;width:min(600px,90%);background:#17243b;color:white;border:1px solid #456;border-radius:8px}table{border-collapse:collapse;width:100%;margin-top:24px}th,td{padding:12px;text-align:left;border-bottom:1px solid #30405c;vertical-align:top}.pass{color:#62d5b0}.fail{color:#ff9696}summary{cursor:pointer}pre{white-space:pre-wrap;max-width:900px;font-size:12px}p{max-width:1000px;color:#b8c5de}</style><h1>Splitwise AI tool-calling benchmark</h1><p>Measured actions, arguments, safety and latency. Search a model, category, case ID or pass/fail. Expand any request to inspect its plan, expected outcome and actual tool trace. Unsuffixed Gemma runs use desktop CPU; -gpu runs use the RTX 4070. These are not phone timings.</p><input id="q" placeholder="Filter results"><table><thead><tr><th>Model</th><th>Case</th><th>Result</th><th>Time</th><th>Prompt and evidence</th></tr></thead><tbody>'''+"".join(table_rows)+'''</tbody></table><script>document.getElementById('q').addEventListener('input',e=>{let q=e.target.value.toLowerCase();document.querySelectorAll('tr[data-search]').forEach(r=>r.hidden=!r.dataset.search.includes(q))})</script></html>'''
    page=page.replace('<input id="q"',headline+'<input id="q"')
    (out / "report.html").write_text(page)
    print(json.dumps({n:{k:v for k,v in m.items() if k in ("total","passed","medianSeconds","p95Seconds","coverage","estimatedUncachedCostUsd")} for n,m in models.items()},indent=2))
    return 1 if args.require_complete and not complete else 0


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["run","report","validate"])
    parser.add_argument("--model",choices=["oracle","gpt-6-luna","e2b","e4b"],default="oracle")
    parser.add_argument("--dataset",default=str(BENCH/"cases.json"))
    parser.add_argument("--output",default=str(DEFAULT_OUTPUT))
    parser.add_argument("--filter",default="")
    parser.add_argument("--reasoning",choices=["none","low","medium"],default="none")
    parser.add_argument("--max-output",type=int,choices=[1024,4096],default=1024)
    parser.add_argument("--backend",choices=["cpu","gpu"],default="cpu",help="Local inference backend; GPU never falls back to CPU")
    parser.add_argument("--java",help="Java 21 executable; use native Windows Java for Direct3D GPU access")
    parser.add_argument("--activation",choices=["default","float16","float32"],default="default",help="Local activation precision, labelled as a separate configuration")
    parser.add_argument("--runner-jar",help="Explicit compiled runner artifact; recorded in the manifest")
    parser.add_argument("--require-complete",action="store_true",help="Fail report generation unless all three models completed every case")
    args=parser.parse_args()
    if args.mode=="report":
        return report(args)
    if args.mode=="validate":
        args.model="oracle"
        code=run(args)
        if code:
            return code
        rows=[json.loads(l) for l in (Path(args.output)/"oracle.jsonl").read_text().splitlines() if l.strip()]
        failures=[(r["caseId"],grade(r)) for r in rows if not grade(r)["passed"]]
        print(json.dumps(dict(oracleCases=len(rows),failures=failures),indent=2))
        return bool(failures)
    return run(args)


if __name__=="__main__":
    sys.exit(main())
