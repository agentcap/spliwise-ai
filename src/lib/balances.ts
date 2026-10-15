import type { Transaction, Person, Repayment, Dashboard, ExpenseBalance } from './types';
export function calculateDashboard(
  transactions: Transaction[],
  people: Person[],
  repayments: Repayment[],
  from?: string,
  to?: string,
): Dashboard {
  const finalized = transactions.filter((t) => t.state === 'finalized' && t.proposal);
  const inRange = (date: string) => (!from || date >= from) && (!to || date <= to);
  const byId = new Map(finalized.map((t) => [t.id, t]));
  const balances = people
    .filter((p) => !p.isSelf)
    .map((person) => {
      const expenses: ExpenseBalance[] = finalized
        .filter((t) => t.amountCents > 0)
        .map((t) => ({
          transactionId: t.id,
          date: t.date,
          description: t.description,
          allocatedCents:
            t.proposal!.splits.find((s) => s.personId === person.id)?.amountCents || 0,
          refundedCents: 0,
          paidCents: 0,
          remainingCents: 0,
        }))
        .filter((e) => e.allocatedCents > 0)
        .sort(
          (a, b) => a.date.localeCompare(b.date) || a.transactionId.localeCompare(b.transactionId),
        );
      let generalCredits = 0;
      for (const refund of finalized.filter((t) => t.amountCents < 0)) {
        const amount = -(
          refund.proposal!.splits.find((s) => s.personId === person.id)?.amountCents || 0
        );
        const expense =
          refund.proposal!.refundOf && byId.has(refund.proposal!.refundOf)
            ? expenses.find((e) => e.transactionId === refund.proposal!.refundOf)
            : undefined;
        if (expense) {
          const applied = Math.min(amount, expense.allocatedCents - expense.refundedCents);
          expense.refundedCents += applied;
          generalCredits += amount - applied;
        } else generalCredits += amount;
      }
      const ownRepayments = repayments.filter((r) => r.personId === person.id);
      const receivedCents = ownRepayments
        .filter((r) => r.direction === 'received')
        .reduce((a, r) => a + r.amountCents, 0);
      const returnedCents = ownRepayments
        .filter((r) => r.direction === 'returned')
        .reduce((a, r) => a + r.amountCents, 0);
      let funds = generalCredits + receivedCents - returnedCents;
      for (const expense of expenses) {
        const net = Math.max(0, expense.allocatedCents - expense.refundedCents);
        const paid = Math.min(net, Math.max(0, funds));
        expense.paidCents = paid;
        expense.remainingCents = net - paid;
        funds -= paid;
      }
      // Returned funds beyond all available credit become an explicit debit.
      const debit = Math.max(0, -funds);
      const outstandingCents = expenses.reduce((a, e) => a + e.remainingCents, 0) + debit;
      return {
        person,
        outstandingCents,
        inRangeOutstandingCents: expenses
          .filter((e) => inRange(e.date))
          .reduce((a, e) => a + e.remainingCents, 0),
        creditCents: Math.max(0, funds),
        receivedCents,
        returnedCents,
        expenses,
      };
    });
  const categories = new Map<string, number>(),
    months = new Map<string, number>();
  let personalCents = 0,
    sharedCents = 0,
    totalSpentCents = 0;
  for (const tx of finalized.filter((t) => inRange(t.date))) {
    totalSpentCents += tx.amountCents;
    const self = tx.proposal!.splits.find((s) => s.personId === 'self')?.amountCents || 0;
    personalCents += self;
    sharedCents += tx.amountCents - self;
    categories.set(
      tx.proposal!.category,
      (categories.get(tx.proposal!.category) || 0) + tx.amountCents,
    );
    const month = tx.date.slice(0, 7);
    months.set(month, (months.get(month) || 0) + tx.amountCents);
  }
  return {
    people: balances,
    totalOutstandingCents: balances.reduce((a, b) => a + b.outstandingCents, 0),
    filteredOutstandingCents: balances.reduce((a, b) => a + b.inRangeOutstandingCents, 0),
    creditCents: balances.reduce((a, b) => a + b.creditCents, 0),
    personalCents,
    sharedCents,
    totalSpentCents,
    inboxCount: transactions.filter((t) => t.state === 'inbox').length,
    readyCount: transactions.filter((t) => t.state === 'ready').length,
    finalizedCount: finalized.length,
    categories: [...categories]
      .map(([name, amountCents]) => ({ name, amountCents }))
      .sort((a, b) => b.amountCents - a.amountCents),
    months: [...months]
      .map(([month, amountCents]) => ({ month, amountCents }))
      .sort((a, b) => a.month.localeCompare(b.month)),
  };
}
