import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";

type Point = { t: string; total: number; errors: number };

const TimeseriesChart = ({ points }: { points: Point[] }) => {
  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 10, padding: 12 }}>
      <div style={{ fontSize: 12, color: "#666" }}>Logs over time</div>
      <div style={{ height: 220, marginTop: 8 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey="t"
              tickFormatter={(v: string) =>
                new Date(v).toISOString().slice(11, 16)
              }
              minTickGap={20}
            />
            <YAxis />
            <Tooltip
              labelFormatter={(v: string) => new Date(String(v)).toISOString()}
            />
            <Legend />
            <Line type="monotone" dataKey="total" dot={false} />
            <Line type="monotone" dataKey="errors" dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

export default TimeseriesChart;
