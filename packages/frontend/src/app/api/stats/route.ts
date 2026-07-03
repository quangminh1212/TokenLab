import { NextResponse } from "next/server";
import { db, users, submissions } from "@/lib/db";
import { desc, sql, eq, and, gte } from "drizzle-orm";

export const revalidate = 60;

interface StatsUser {
  userId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  totalTokens: number;
  totalCost: number;
  totalActiveTimeMs: number | null;
  submissionCount: number | null;
  lastSubmission: string;
  rank: number;
}

export async function GET() {
  try {
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    const [aggregateResult, topUsersResult] = await Promise.all([
      db
        .select({
          totalTokens: sql<number>`COALESCE(SUM(${submissions.totalTokens}), 0)`,
          totalCost: sql<number>`COALESCE(SUM(CAST(${submissions.totalCost} AS DECIMAL(14,4))), 0)`,
          totalActiveTimeMs: sql<number>`COALESCE(SUM(${submissions.totalActiveTimeMs}), 0)`,
          totalSubmissions: sql<number>`COALESCE(SUM(${submissions.submitCount}), 0)`,
          uniqueUsers: sql<number>`COUNT(DISTINCT ${submissions.userId})`,
        })
        .from(submissions),

      db
        .select({
          userId: submissions.userId,
          username: users.username,
          displayName: users.displayName,
          avatarUrl: users.avatarUrl,
          totalTokens: sql<number>`COALESCE(SUM(${submissions.totalTokens}), 0)`,
          totalCost: sql<number>`COALESCE(SUM(CAST(${submissions.totalCost} AS DECIMAL(14,4))), 0)`,
          totalActiveTimeMs: sql<number>`COALESCE(SUM(${submissions.totalActiveTimeMs}), 0)`,
          submissionCount: sql<number>`COALESCE(MAX(${submissions.submitCount}), 0)`,
          lastSubmission: sql<string>`MAX(${submissions.updatedAt})`,
        })
        .from(submissions)
        .innerJoin(users, eq(submissions.userId, users.id))
        .groupBy(submissions.userId, users.username, users.displayName, users.avatarUrl)
        .orderBy(desc(sql`COALESCE(SUM(${submissions.totalTokens}), 0)`))
        .limit(10),
    ]);

    const [agg] = aggregateResult;

    const rankedUsers: StatsUser[] = topUsersResult.map((u, i) => ({
      userId: u.userId,
      username: u.username,
      displayName: u.displayName,
      avatarUrl: u.avatarUrl,
      totalTokens: Number(u.totalTokens) || 0,
      totalCost: Number(u.totalCost) || 0,
      totalActiveTimeMs: u.totalActiveTimeMs ? Number(u.totalActiveTimeMs) : null,
      submissionCount: u.submissionCount ? Number(u.submissionCount) : null,
      lastSubmission: u.lastSubmission ? String(u.lastSubmission) : "",
      rank: i + 1,
    }));

    return NextResponse.json({
      stats: {
        totalTokens: Number(agg?.totalTokens) || 0,
        totalCost: Number(agg?.totalCost) || 0,
        totalActiveTimeMs: agg?.totalActiveTimeMs ? Number(agg.totalActiveTimeMs) : null,
        totalSubmissions: Number(agg?.totalSubmissions) || 0,
        uniqueUsers: Number(agg?.uniqueUsers) || 0,
      },
      users: rankedUsers,
    });
  } catch (error) {
    console.error("Stats API error:", error);
    return NextResponse.json(
      {
        stats: {
          totalTokens: 0,
          totalCost: 0,
          totalActiveTimeMs: null,
          totalSubmissions: 0,
          uniqueUsers: 0,
        },
        users: [],
      },
      { status: 200 }
    );
  }
}
