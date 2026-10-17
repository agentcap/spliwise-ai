# Fine-Tuning Gemma 4 E2B for an Expense Assistant: What Actually Helped

My first fine-tuning run reached 94% on its development set. On a separate test of unfamiliar task combinations, it improved by just three cases.

That gap became the most useful result of the experiment. It pushed me to inspect what the model was learning, broaden the training data, and simplify the interface between the model and the app. A second round produced much stronger results: the best configuration passed 110 of 140 cases on the original regression benchmark and 104 of 128 cases on a fresh held-out test.

It also still made mistakes that would matter in a finance app. Here is what changed, what the measurements support, and why I have kept the result experimental.

## The task was more demanding than producing valid tool calls

The project is an Android expense assistant with 16 tools. It can search transactions, manage people and trips, remember facts, save rules and templates, and prepare expenses, splits, assignments, and repayments for confirmation.

The difficult part is choosing the right action and scope. A one-off split should not become a recurring rule. Applying an existing template should not create another template. A note about a trip should not acquire an unrelated person or date. “Split this with my friend” should trigger a clarification when the person is unspecified.

The assistant also needs to distinguish a proposed change from an approved change, and a successful action from a rejected one.

I evaluated these behaviors against the app’s actual dispatcher and validators, using synthetic, in-memory database fixtures. The experiments did not read or change real financial records. Financial changes were staged for confirmation.

## Keeping the comparison controlled

I used the official `google/gemma-4-E2B-it` checkpoint and trained locally on an RTX 4070 with 12 GB of VRAM. The setup used four-bit QLoRA, BF16 compute, rank-16 adapters, and one training epoch. Training supervised assistant tool calls and response openings; user prompts and tool-result bodies were masked out of the loss.

For each controlled comparison, the base and adapted models used the same checkpoint, tokenizer, tool format, CUDA backend, quantization, and greedy generation settings. Each request could run through several tool rounds before producing a final response.

The original benchmark contained 141 scenarios. One inconsistent fixture was excluded from every headline comparison, leaving a common denominator of 140. I treated this as a regression benchmark because I had already inspected it. Separate held-out sets tested task combinations absent from training.

## Round one: an impressive development score with limited transfer

The first dataset contained 600 synthetic training episodes across 25 composition families. A 50-case development set used familiar families with different entities. An 80-case held-out set covered eight unfamiliar combinations.

Training took about 18 minutes and stayed below 8 GB of allocated GPU memory. The results looked very different depending on which set I examined:

| Evaluation set | Base model | Fine-tuned model |
| --- | ---: | ---: |
| Development: familiar task families | 9/50 (18%) | 47/50 (94%) |
| Held-out: unfamiliar combinations | 35/80 (43.75%) | 38/80 (47.5%) |
| Original regression benchmark | 65/140 (46.4%) | 72/140 (51.4%) |

All three additional held-out successes came from one family involving multiple receipts. The other seven families showed no improvement in pass counts.

There were useful gains in argument formatting and some rule and split workflows. There were also regressions: the original benchmark’s safety category fell from 11/12 to 6/12, and clarification fell from 15/15 to 13/15. Rejected tool calls increased as the model repeated invalid actions.

The training data helped explain this. It had no successful answer-only examples. Its generic completion response repeatedly told the user that changes were prepared and needed confirmation. The model learned that pattern even when it was inappropriate.

Low training loss and a high development score showed that the model could learn the supplied patterns. The held-out results showed how little that established about unfamiliar combinations.

## Round two: broader examples and less bookkeeping

The next experiment tested two changes separately and together.

First, I expanded and rebalanced the training data to 2,476 episodes across 96 composition families. That included 420 answer-only outcomes and 320 clarification outcomes, along with more examples of scoped facts, existing-template application, unsupported requests, untrusted receipt text, and mixed actions.

The new development set contained 64 cases. A fresh held-out set contained 128 cases across 32 other combinations. Training, development, and held-out combinations and entity namespaces were disjoint, and the sets were frozen before training.

A larger benchmark would have improved measurement. Changing the training coverage gave the model examples of the behaviors it needed to learn.

Second, I reduced the model’s bookkeeping burden. A fixed keyword-based selector exposed an average of 5.28 relevant tools per request, compared with the full set of 16. The interface also simplified arguments. The app supplied record versions, converted monetary units, and handled deterministic split arithmetic through the existing ledger logic.

The model still chose the intent, participants, scope, category, and completion outcome. The wrapper only inferred a selected transaction when exactly one was selected; with multiple selections, an explicit transaction identifier remained necessary. Every translated call still passed through the same native validators.

This interface change bundled tool selection, prompt changes, and argument simplification. The experiment measured their combined effect; it did not isolate the contribution of each component.

## What the four-way comparison showed

I compared the base model and a newly trained adapter under each interface. Both adapters started from the same official base checkpoint, rather than continuing the first adapter.

| Configuration | Fresh held-out test | Original regression benchmark |
| --- | ---: | ---: |
| Base model, full interface | 12/128 (9.4%) | 65/140 (46.4%) |
| Base model, simplified interface | 26/128 (20.3%) | 90/140 (64.3%) |
| Broader training, full interface | 99/128 (77.3%) | 106/140 (75.7%) |
| Broader training, simplified interface | **104/128 (81.25%)** | **110/140 (78.6%)** |

Broader training produced the largest improvement. Under the full interface, it raised fresh held-out passes from 12 to 99. Simplifying the interface also helped the untrained base model, especially on the original benchmark.

Combining the changes produced the highest totals, although the additional gain over broader training alone was modest. It was also uneven: on the original benchmark, the combined configuration won 14 cases that the trained full-interface model failed, while losing 10 that it passed.

The two rounds used different held-out sets, so their percentages should not be read as a direct before-and-after comparison. The original 140-case benchmark provides the shared reference: the first adapter passed 72 cases; the best second-round configuration passed 110.

The simplified interface shortened training sequences by about 35%. Its adapter trained in roughly 48 minutes, compared with 74 minutes for the full-interface adapter. On the original benchmark, median request time fell from 10.6 seconds for the trained full-interface model to 7.3 seconds for the combined configuration.

Those timings include tool rounds and failed requests. They describe whole-request behavior, rather than isolated decoding speed. The combined configuration was still slower than the base full-interface model on that benchmark.

## Why 81% was still insufficient

The remaining failures were more revealing than the headline score.

For “Split the selected expense with my friend,” the combined model guessed an existing person and staged a split. It should have asked which friend. Across the original benchmark, clarification performance fell from a perfect 15/15 for the base model to 10/15 for the combined configuration.

In another case, the model tried to save a trip note using a transaction identifier as the trip identifier. The dispatcher rejected the save. A separate template allocation succeeded, and the final response nevertheless claimed that the note had been saved too.

Other failures included adding an unrequested person or date to a fact, mishandling multiple selected expenses, and abandoning a lookup after an overly specific search returned no results.

The combined model passed all 12 cases in the benchmark’s named safety category. That result has a narrow meaning: it passed those 12 checks. It does not resolve the ambiguity and false-completion failures elsewhere in the evaluation.

The best configuration still failed 24 of 128 fresh held-out cases and 30 of 140 original cases. Those failures are enough to keep it experimental.

## Measuring the model required debugging the harness

Some early evaluation failures came from infrastructure. Malformed model output initially crashed the parser instead of becoming a recorded protocol failure. Later timeouts coincided with a game using most of the same GPU. A connection-reuse problem also appeared between the evaluation client and local server.

I fixed the parser and connection handling, resumed after the GPU became available, and reran the comparisons. Discarded runs were retained separately. All four final evaluation passes completed without infrastructure errors, and their saved traces were independently regraded.

This work mattered because a crashed request or a busy GPU can otherwise look like a model regression.

## Training success did not finish Android deployment

The measurements above came from CUDA evaluation. The Android app uses a different LiteRT-LM runtime and model format, so these scores do not establish phone performance.

In the first round, I merged the adapter into the original BF16 model and attempted conversion. The export process exceeded the configured host-memory guard and was stopped. Training had fit comfortably in GPU memory; conversion placed a different demand on system RAM.

No successfully converted `.litertlm` artifact or physical-phone validation resulted from that attempt. The second-round adapters have not been exported, and the Android app’s production model remains unchanged.

## What I would test next

The next training changes should target the observed failures: paired examples where naming a person permits an action and “my friend” requires clarification; recovery traces after rejected tool calls; and better handling of multiple selected records.

I would also move more completion reporting into the app. A response that claims an action succeeded should be grounded in the actions the dispatcher actually accepted. Evaluation needs to check that relationship explicitly.

Finally, both rounds relied on synthetic data with shared authoring and correlated templates. Disjoint combinations and different entities provide useful separation, but they do not establish broad real-world reliability. A further test should use independently authored requests and varied conversation histories, frozen before the next training run.

The first round showed how convincing a development score could look. The second showed that broader behavioral coverage and a simpler interface could produce substantial measured gains. Before this model belongs in the app, it still needs to ask which friend I mean—and describe a failed save honestly.
