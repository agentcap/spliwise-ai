"""Regression tests for the benchmark's failure-detection logic."""
import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("benchmark", Path(__file__).resolve().parents[2] / "scripts/tool-benchmark.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ScoringTests(unittest.TestCase):
    def row(self):
        expected = dict(organization=[],requests=[],updates=[dict(id="a",state="ready",proposal=dict(
            category="Food",splits=[dict(personId="self",amountCents=700),dict(personId="alex",amountCents=500)]))])
        return dict(expect=expected,plan=copy.deepcopy(expected),reply="Please confirm.",
                    trace=[],committed=True,error=None,financialStateUnchanged=True)

    def test_good_plan(self):
        self.assertTrue(module.grade(self.row())["passed"])

    def test_order_is_irrelevant(self):
        row=self.row(); row["plan"]["updates"][0]["proposal"]["splits"].reverse()
        self.assertTrue(module.grade(row)["passed"])

    def test_wrong_cents(self):
        row=self.row(); row["plan"]["updates"][0]["proposal"]["splits"][0]["amountCents"]=701
        self.assertFalse(module.grade(row)["passed"])

    def test_swapped_people(self):
        row=self.row(); row["plan"]["updates"][0]["proposal"]["splits"][0]["personId"]="zara"
        self.assertFalse(module.grade(row)["passed"])

    def test_extra_action(self):
        row=self.row(); row["plan"]["organization"].append(dict(kind="rule"))
        self.assertFalse(module.grade(row)["passed"])

    def test_wrong_target(self):
        row=self.row(); row["plan"]["updates"][0]["id"]="unselected"
        self.assertFalse(module.grade(row)["passed"])

    def test_missing_action(self):
        row=self.row(); row["plan"]["updates"]=[]
        self.assertFalse(module.grade(row)["passed"])

    def test_no_financial_mutation(self):
        row=self.row(); row["financialStateUnchanged"]=False
        self.assertFalse(module.grade(row)["passed"])

    def test_commit_error(self):
        row=self.row(); row["error"]="stale version";row["committed"]=False
        self.assertFalse(module.grade(row)["passed"])

    def test_clarification_needs_question(self):
        row=self.row();row["expect"]["updates"]=[];row["plan"]["updates"]=[];row["expect"]["question"]=True
        self.assertFalse(module.grade(row)["passed"])
        row["reply"]="Which person do you mean?"
        self.assertTrue(module.grade(row)["passed"])

    def test_recovery_not_first_pass(self):
        row=self.row();row["trace"]=[dict(name="propose_split",response=dict(error="stale"))]
        self.assertTrue(module.grade(row)["passed"])
        self.assertFalse(module.grade(row)["firstPass"])

    def test_weight_pairs_preserved(self):
        self.assertFalse(module.matches(dict(mode="percent",participants=["a","b"],values=[2500,7500]),
                                       dict(mode="percent",participants=["a","b"],values=[7500,2500])))
        self.assertTrue(module.matches(dict(mode="percent",participants=["b","a"],values=[2500,7500]),
                                      dict(mode="percent",participants=["a","b"],values=[7500,2500])))

    def test_no_extra_rule_scope(self):
        expected=dict(merchant="CAFE",split=dict(mode="personal",participants=["self"]))
        self.assertFalse(module.matches(dict(expected,accountId="unrequested"),expected))

    def test_balance_substring_is_not_amount(self):
        row=self.row();row["expect"]["updates"]=[];row["plan"]["updates"]=[];row["expect"]["answerContains"]=["6"]
        row["reply"]="$16.00";self.assertFalse(module.grade(row)["passed"])
        row["reply"]="$6.00";self.assertTrue(module.grade(row)["passed"])
        row["reply"]="Alex owes $6.00.";self.assertTrue(module.grade(row)["passed"])
        row["reply"]="Alex owes $6.01.";self.assertFalse(module.grade(row)["passed"])

    def test_false_success_without_action(self):
        row=self.row();row["expect"]["updates"]=[];row["plan"]["updates"]=[]
        row["reply"]="I have finalized everything."
        self.assertFalse(module.grade(row)["passed"])

    def test_argument_types_and_enums(self):
        schema=dict(type="object",required=["version","mode"],properties=dict(version=dict(type="integer"),mode=dict(type="string",enum=["equal","personal"])))
        self.assertEqual(module.argument_errors(dict(version=1,mode="equal"),schema),[])
        self.assertEqual(module.argument_errors(dict(version=1.0,mode="equal"),schema),[])
        self.assertTrue(module.argument_errors(dict(version="1",mode="equal"),schema))
        self.assertTrue(module.argument_errors(dict(version=True,mode="equal"),schema))
        self.assertTrue(module.argument_errors(dict(version=1,mode="unknown"),schema))
        self.assertTrue(module.argument_errors(dict(mode="equal"),schema))

    def test_verbal_zero_balance(self):
        row=self.row();row["expect"]["updates"]=[];row["plan"]["updates"]=[];row["expect"]["answerContains"]=["0"]
        row["reply"]="Zara does not owe anything."
        self.assertTrue(module.grade(row)["passed"])
        row["reply"]="I don't know Zara's balance."
        self.assertFalse(module.grade(row)["passed"])

    def test_explicit_clarification_tool_without_punctuation(self):
        row=self.row();row["expect"]["updates"]=[];row["plan"]["updates"]=[];row["expect"]["question"]=True
        row["reply"]="Please identify the friend"
        row["trace"]=[dict(name="request_clarification",arguments=dict(question=row["reply"]),response=dict(clarification=row["reply"]))]
        self.assertTrue(module.grade(row)["passed"])

    def test_unparsed_control_text_is_not_a_completed_answer(self):
        row=self.row();row["expect"]["updates"]=[];row["plan"]["updates"]=[]
        row["reply"]='finish_reply{outcome:<|"|>answer<|"|>,message:<|"|>No change<|"|>}'
        self.assertFalse(module.grade(row)["passed"])
        self.assertTrue(module.grade(row)["unparsedControlResponse"])
        row=self.row();row["reply"]='finish_reply{outcome:<|"|>changes_prepared<|"|>}'
        self.assertTrue(module.grade(row)["passed"])
        self.assertFalse(module.grade(row)["firstPass"])


if __name__=="__main__":
    unittest.main()
