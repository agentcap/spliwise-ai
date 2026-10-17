# Gemma E2B: broader training and a reduced tool interface

Both changes improved completion in the matched CUDA experiment. Broader training supplied most of the gain; the reduced interface added a smaller accuracy gain and improved speed compared with the trained model using full tools. The combined configuration is the strongest measured candidate.

**Keep the adapters experimental.** The combined configuration still fails 24/128 fresh cases and 30/140 regression cases. Clarification falls from 15/15 to 10/15, and some raw replies claim an action succeeded after its tool was rejected. Passing the small 12-case safety category does not establish overall safe behavior. The deployed app model is unchanged.

| Configuration | Fresh held-out success | Original regression success | Held-out median | Regression median |
| --- | ---: | ---: | ---: | ---: |
| Base, full tools | 12/128 (9.4%) | 65/140 (46.4%) | 14.04s | 6.70s |
| Base, reduced interface | 26/128 (20.3%) | 90/140 (64.3%) | 12.21s | 5.94s |
| Broader training, full tools | 99/128 (77.3%) | 106/140 (75.7%) | 18.19s | 10.59s |
| Broader training + reduced interface | 104/128 (81.2%) | 110/140 (78.6%) | 16.22s | 7.31s |

## Protocol reliability

| Configuration / set | First-pass success | Cases with argument errors | Rejected calls | p95 |
| --- | ---: | ---: | ---: | ---: |
| Base, full tools / heldout | 5/128 | 62 | 114 | 20.88s |
| Base, reduced interface / heldout | 18/128 | 56 | 111 | 19.33s |
| Broader training, full tools / heldout | 99/128 | 3 | 16 | 26.30s |
| Broader training + reduced interface / heldout | 103/128 | 2 | 10 | 23.79s |
| Base, full tools / exposed | 50/140 | 44 | 51 | 14.51s |
| Base, reduced interface / exposed | 45/140 | 36 | 52 | 13.61s |
| Broader training, full tools / exposed | 102/140 | 7 | 51 | 21.77s |
| Broader training + reduced interface / exposed | 106/140 | 9 | 32 | 15.13s |

First-pass success additionally requires no rejected call or schema error. Primary completion can count a successful recovery. Scenario timings include failures and all tool rounds, so they do not isolate decoder throughput or LoRA compute overhead.

## Interpretation

Broader training with full tools improved 87 fresh cases and regressed none, raising completion from 12/128 to 99/128. On the original benchmark it improved 49 cases and regressed eight, raising completion from 65/140 to 106/140.

The reduced interface alone raised the unchanged base from 65/140 to 90/140 on the original benchmark, and from 12/128 to 26/128 on fresh combinations. It exposed an average of 5.28 tools instead of 16. This is evidence that contract complexity was a substantial bottleneck.

The combined configuration reached 104/128 and 110/140. Relative to the trained full interface, this is 11 improvements versus six regressions on fresh cases, and 14 improvements versus ten regressions on the original benchmark. The incremental accuracy gain is modest and not uniform. Its median was 10.8% faster on fresh cases and 31.0% faster on the original benchmark than the trained full interface. It remained slower than the unchanged base/full interface: 16.22 versus 14.04 seconds on fresh cases, and 7.31 versus 6.70 seconds on the original benchmark.

The CUDA baseline still scores the same 65/140 as the first experiment. The new 128-case composition test differs from the first experiment's 80-case test, so their percentages should not be compared as a common benchmark. The existing LiteRT/Android model uses a different runtime and quantization; these CUDA results do not establish phone performance.

## Data and training

2,476 synthetic training episodes cover 96 composition families and 40 primitive scenario types. They include 420 answer-only outcomes and 320 clarification outcomes. Development has 64 cases across 16 unseen combinations; held-out has 128 cases across 32 other combinations. Train, development and held-out combinations and entity namespaces are disjoint. All oracle traces pass the production ledger; reduced targets round-trip to the same native actions. The exposed benchmark has no exact training-prompt matches or eight-word training-prompt overlaps; lexical checks cannot rule out all semantic similarity.

Two independent adapters start from the pinned official google/gemma-4-E2B-it revision 3e22461f65e89153144f8adb70e3b8c2cc9845a7. Each sees the same semantic episodes, serialized for its respective interface. Both use NF4/BF16 CUDA QLoRA, rank 16, alpha 32, learning rate 1e-4, effective batch eight, one epoch and 310 optimizer updates. No checkpoint or hyperparameter selection uses held-out scores. The full-interface run took 74.3 minutes; the reduced run took 48.1 minutes.

The reduced interface uses fixed retrieval rules over user messages and current selection. It converts dollars and percentages to ledger units, supplies versions from records already observed, defaults an omitted split category to the visible category, and permits an omitted expense ID only with exactly one selected expense. The model still chooses the requested operation, participants, scope and completion. No oracle, expected plan or case metadata enters model inference.

## Important regressions and remaining failures

| Category on original benchmark | Base/full | Broader/full | Broader/reduced |
| --- | ---: | ---: | ---: |
| safety | 11/12 | 11/12 | 12/12 |
| clarification | 15/15 | 11/15 | 10/15 |
| splits | 6/22 | 17/22 | 19/22 |
| scope_and_search | 6/11 | 9/11 | 7/11 |
| rules | 3/20 | 17/20 | 14/20 |
| trips | 0/14 | 6/14 | 7/14 |
| web_history | 7/15 | 10/15 | 14/15 |
| context_and_multiaction | 1/6 | 5/6 | 6/6 |

The combined configuration improves 93 fresh cases and regresses one versus the base/full configuration. On the original benchmark it improves 54 and regresses nine. Failures remain concentrated in these behaviors:

- Ambiguous people: “split with my friend” can select a person instead of asking which friend. The clarification category therefore remains a deployment blocker.
- Multiple selected expenses: the model sometimes omits transaction IDs even when several are visible, then asks the user for IDs after the interface rejects the call.
- Trip facts: it can use an expense ID as a trip ID, or add an unrequested person/date scope. Two fresh trip-fact combinations score 0/4 each.
- Error recovery and truthful completion: a rejected fact or repayment can be followed by a reply saying it was saved or prepared. For example, v2-heldout-30000 uses the receipt ID as a trip ID and falsely claims the note was saved; v2-heldout-30006 selects self as repayment person and still claims the repayment is prepared.
- Reads and clarification: the model can answer a balance using staged shares instead of the snapshot balance, or ask about a refund while omitting another requested balance answer.
- Empty lookups: queries such as “DOORDASH rule” or “Colorado trip” may return no exact match; the model stops instead of retrying the entity name alone.

The next bounded iteration should address those behaviors before deployment: explicit ambiguity contrasts, correction trajectories after rejected tools, broader-query recovery, and batch-selection examples. Application-generated completion summaries should reflect actual successful actions and failures. These changes have not been implemented or retested in this experiment.

## Verification and limits

An independent audit regrades every final result with the production scorer and the same additional fresh-case memory-scope check. It verifies all data/source/adapter hashes, all 490 finite LoRA tensors per adapter, 205 nonzero B matrices, identical inference settings, and all 334 initial prompts per interface by case ID. The remaining 40 zero B matrices correspond exactly to unused key/value projections in the last 20 KV-sharing layers. All 1,336 raw cases including warmups preserve the synthetic financial state. The final four passes contain zero HTTP/connection/resource infrastructure failures. The same inconsistent personal-04 fixture is excluded from every headline regression score.

Untrained data preflight, a malformed-parser failure, GPU contention, and a local HTTP closure race are retained separately. Evaluation amendments record the fixes, timestamps and hashes. An external game workload was confirmed by host GPU counters and closed before the final passes. The final runtime uses identical per-request cache cleanup, allocator headroom and explicit connection closure for all arms. Training data, completed weights, tool semantics and scoring were unchanged by those repairs. Discarded passes do not contribute to the headline metrics.

The cases are synthetic and family variants are correlated. Shared authoring/generation limits external validity. Data quantity and diversity change together, and the reduced interface combines retrieval, prompt wording and bookkeeping changes, so their individual contributions are not identified. Scores check structured actions, required arguments, ledger acceptance and selected answer anchors; they are not a complete semantic audit of every reply. No physical phone, energy, thermal, LiteRT export, or Android loading tests were run for these new adapters.

## Artifacts and reproduction

- Full and reduced adapters: full/adapter/ and reduced/adapter/ in the experiment directory.
- Complete paired/category/family results: comparison.json. Independent integrity and per-case grades: final-audit.json.
- Data, masks, validations, settings, original sources, corrected evaluation sources, raw native outputs and ledger traces remain beside this report.
- Reproduction: finetuning/gemma4-e2b/experiment-v2.md. The ZIP contains both adapters and the measured evidence; it excludes the shared base checkpoint and compiled caches.
- To relocate an adapter, explicitly load the pinned official base before loading PEFT weights. Saved adapter configuration references the original local base path.
