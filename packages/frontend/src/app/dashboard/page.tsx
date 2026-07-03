import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import DashboardClient from "./DashboardClient";

export const revalidate = 60;

function getBaseUrl(): string {
  return process.env.NEXT_PUBLIC_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
    || 'http://127.0.0.1:3000';
}

async function getDashboardData(username: string) {
  const res = await fetch(`${getBaseUrl()}/api/users/${username}`, {
    next: { revalidate: 60 },
  });
  if (!res.ok) return null;
  return res.json();
}

export default async function DashboardPage() {
  const session = await getSession();

  if (!session) {
    redirect("/api/auth/github?returnTo=/dashboard");
  }

  const data = await getDashboardData(session.username);

  if (!data) {
    redirect(`/u/${session.username}`);
  }

  return <DashboardClient data={data} />;
}
