'use client';
import { useEffect, useState } from 'react';
import { api } from './ui';
import { money } from '@/lib/money';
import type { ExpenseBalance, Repayment } from '@/lib/types';
export default function PersonLedger({
  id,
  from,
  to,
  onOpen,
}: {
  id: string;
  from: string;
  to: string;
  onOpen: (id: string) => void;
}) {
  const [page, setPage] = useState(0),
    [data, setData] = useState<{
      expenses: ExpenseBalance[];
      repayments: Repayment[];
      total: number;
      repaymentCount: number;
    } | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const q = new URLSearchParams({ from, to, page: String(page) });
    api<typeof data>('balances/' + id + '?' + q)
      .then((d) => {
        if (active) {
          setData(d);
          setError('');
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [id, from, to, page]);
  if (error) return <p role="alert">{error}</p>;
  if (!data) return <p>Loading expenses…</p>;
  return (
    <>
      <table>
        <thead>
          <tr>
            <th>Expense</th>
            <th>Allocated</th>
            <th>Refunded</th>
            <th>Paid</th>
            <th>Unpaid</th>
          </tr>
        </thead>
        <tbody>
          {data.expenses.map((e) => (
            <tr key={e.transactionId}>
              <td>
                <b>{e.description}</b>
                <small>{e.date}</small>
                <button className="text-button" onClick={() => onOpen(e.transactionId)}>
                  View expense
                </button>
              </td>
              <td>{money(e.allocatedCents)}</td>
              <td>{money(e.refundedCents)}</td>
              <td>{money(e.paidCents)}</td>
              <td>
                <b>{money(e.remainingCents)}</b>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3 className="spaced">Repayment history</h3>
      {data.repayments.map((r) => (
        <div className="repayment-row" key={r.id}>
          <span>
            {r.date} · {r.direction === 'received' ? 'Received' : 'Returned'}
            <small>{r.note}</small>
          </span>
          <b>{money(r.amountCents)}</b>
        </div>
      ))}
      <div className="pagination">
        <button className="quiet-button" disabled={!page} onClick={() => setPage(page - 1)}>
          Previous
        </button>
        <span>
          Page {page + 1} · {data.total} expenses · {data.repaymentCount} repayments
        </span>
        <button
          className="quiet-button"
          disabled={(page + 1) * 50 >= Math.max(data.total, data.repaymentCount)}
          onClick={() => setPage(page + 1)}
        >
          Next
        </button>
      </div>
    </>
  );
}
