"use client";

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { moneyCompact } from "@/lib/format";

interface Point {
  day: string;
  orders: number;
  revenue: string;
  pos: string;
  online: string;
}

export function SalesChart({ data }: { data: Point[] }) {
  if (!data.length) {
    return (
      <div className="flex h-64 items-center justify-center text-body-sm text-muted">
        No sales in this period.
      </div>
    );
  }

  const series = data.map((point) => ({
    day: new Date(point.day).toLocaleDateString("en-GB", { day: "2-digit", month: "short" }),
    Total: Number(point.revenue),
    POS: Number(point.pos),
    Online: Number(point.online),
  }));

  return (
    <>
      <div className="h-64" aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--neutral-200)" vertical={false} />
            <XAxis
              dataKey="day"
              tick={{ fontSize: 12, fill: "var(--neutral-500)" }}
              tickLine={false}
              axisLine={{ stroke: "var(--neutral-200)" }}
            />
            <YAxis
              tick={{ fontSize: 12, fill: "var(--neutral-500)" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(value) => moneyCompact(value)}
            />
            <Tooltip
              formatter={(value: number) => moneyCompact(value)}
              contentStyle={{
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--border)",
                fontSize: 12,
              }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {/* Series are distinguished by colour AND by dash pattern, so the
                chart still reads without colour perception. */}
            <Line type="monotone" dataKey="Total" stroke="var(--brand-500)" strokeWidth={2} dot={false} />
            <Line
              type="monotone"
              dataKey="POS"
              stroke="var(--neutral-900)"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="Online"
              stroke="var(--info)"
              strokeWidth={1.5}
              strokeDasharray="1 3"
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* The same data as a table, for screen readers and for anyone who wants
          the numbers rather than the shape. */}
      <details className="mt-2">
        <summary className="cursor-pointer text-caption text-muted">View as table</summary>
        <table className="mt-2 w-full text-body-sm">
          <caption className="sr-only">Sales by day</caption>
          <thead className="text-left text-caption uppercase text-muted">
            <tr>
              <th scope="col" className="py-1">Day</th>
              <th scope="col" className="py-1 text-right">POS</th>
              <th scope="col" className="py-1 text-right">Online</th>
              <th scope="col" className="py-1 text-right">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {series.map((row) => (
              <tr key={row.day}>
                <td className="py-1">{row.day}</td>
                <td className="tabular py-1 text-right">{moneyCompact(row.POS)}</td>
                <td className="tabular py-1 text-right">{moneyCompact(row.Online)}</td>
                <td className="tabular py-1 text-right font-medium">{moneyCompact(row.Total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </>
  );
}
