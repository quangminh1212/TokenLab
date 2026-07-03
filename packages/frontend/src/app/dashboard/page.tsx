import { redirect } from "next/navigation";
import DashboardClient from "./DashboardClient";

export const revalidate = 60;

function getBaseUrl(): string {
  return process.env.NEXT_PUBLIC_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
    || 'http://127.0.0.1:3000';
}

async function getLeaderboardData() {
  const res = await fetch(`${getBaseUrl()}/api/leaderboard?limit=10&sortBy=tokens`, {
    next: { revalidate: 60 },
  });
  if (!res.ok) return null;
  return res.json();
}

export default async function DashboardPage() {
  const leaderboardData = await getLeaderboardData();

  if (!leaderboardData) {
    redirect("/leaderboard");
  }

  return <DashboardClient leaderboard={leaderboardData} />;
}
