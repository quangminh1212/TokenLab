"use client";

import { useMemo } from "react";
import styled from "styled-components";
import Link from "next/link";
import { Navigation } from "@/components/layout/Navigation";
import { Footer } from "@/components/layout/Footer";
import { formatNumber, formatCurrency } from "@/lib/utils";

interface LeaderboardUser {
  rank: number;
  userId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  totalTokens: number;
  totalCost: number;
  totalActiveTimeMs: number | null;
  submissionCount: number | null;
  lastSubmission: string;
}

interface StatsData {
  stats: {
    totalTokens: number;
    totalCost: number;
    totalActiveTimeMs: number | null;
    totalSubmissions: number | null;
    uniqueUsers: number;
  };
  users: LeaderboardUser[];
}

interface DashboardClientProps {
  data: StatsData;
}

const PageContainer = styled.div`
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background-color: var(--color-bg-default);
`;

const MainContent = styled.main`
  flex: 1;
  max-width: 1024px;
  margin: 0 auto;
  padding: 32px 24px;
  width: 100%;
`;

const Title = styled.h1`
  font-size: 28px;
  font-weight: 800;
  color: var(--color-fg-default);
  margin: 0 0 8px 0;
`;

const Subtitle = styled.p`
  font-size: 14px;
  color: var(--color-fg-muted);
  margin: 0 0 32px 0;
`;

const HeroGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
  margin-bottom: 24px;

  @media (min-width: 768px) {
    grid-template-columns: repeat(4, 1fr);
  }
`;

const HeroCard = styled.div`
  border-radius: 16px;
  border: 1px solid var(--color-border-default);
  padding: 20px;
  background-color: var(--color-bg-elevated);
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

const HeroLabel = styled.span`
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-fg-muted);
`;

const HeroValue = styled.span`
  font-size: 28px;
  font-weight: 800;
  letter-spacing: -0.03em;
  color: var(--color-fg-default);

  @media (min-width: 768px) {
    font-size: 32px;
  }
`;

const HeroSub = styled.span`
  font-size: 12px;
  color: var(--color-fg-muted);
`;

const SectionTitle = styled.h2`
  font-size: 16px;
  font-weight: 700;
  color: var(--color-fg-default);
  margin: 0 0 16px 0;
`;

const Card = styled.div`
  border-radius: 16px;
  border: 1px solid var(--color-border-default);
  padding: 24px;
  background-color: var(--color-bg-elevated);
  margin-bottom: 24px;
`;

const UserList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0;
`;

const UserRow = styled(Link)`
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 0;
  border-bottom: 1px solid var(--color-border-default);
  text-decoration: none;
  color: inherit;
  transition: background-color 0.15s ease;

  &:last-child {
    border-bottom: none;
  }

  &:hover {
    background-color: var(--color-bg-subtle);
    margin: 0 -12px;
    padding: 14px 12px;
    border-radius: 8px;
    border-bottom-color: transparent;
  }
`;

const RankText = styled.span`
  font-size: 16px;
  font-weight: 700;
  color: var(--color-fg-muted);
  min-width: 36px;
  text-align: center;
`;

const Avatar = styled.img`
  width: 36px;
  height: 36px;
  border-radius: 6px;
  object-fit: cover;
  flex-shrink: 0;
`;

const UserInfo = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
`;

const UserName = styled.span`
  font-size: 14px;
  font-weight: 600;
  color: var(--color-fg-default);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const UserHandle = styled.span`
  font-size: 12px;
  color: var(--color-fg-muted);
`;

const UserStats = styled.div`
  display: flex;
  gap: 24px;
  align-items: center;
  flex-shrink: 0;
`;

const UserStat = styled.div`
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
`;

const UserStatValue = styled.span`
  font-size: 14px;
  font-weight: 700;
  color: var(--color-fg-default);
`;

const UserStatLabel = styled.span`
  font-size: 11px;
  color: var(--color-fg-muted);
`;

const BarChartContainer = styled.div`
  display: flex;
  align-items: flex-end;
  gap: 6px;
  height: 180px;
  overflow-x: auto;
  padding-bottom: 8px;
`;

const BarChartBar = styled.div<{ $height: number; $color: string }>`
  flex: 1;
  min-width: 24px;
  max-width: 60px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
`;

const BarFill = styled.div<{ $height: number; $color: string }>`
  width: 100%;
  height: ${props => props.$height}%;
  border-radius: 6px 6px 0 0;
  background-color: ${props => props.$color};
  opacity: ${props => props.$height < 5 ? 0.4 : 1};
  transition: opacity 0.2s;
  min-height: 4px;

  &:hover {
    opacity: 1;
  }
`;

const BarLabel = styled.span`
  font-size: 11px;
  color: var(--color-fg-muted);
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
`;

const ChartEmpty = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--color-fg-muted);
  font-size: 14px;
`;

const EmptyState = styled.div`
  text-align: center;
  padding: 48px 24px;
  color: var(--color-fg-muted);
`;

const EmptyTitle = styled.h3`
  font-size: 18px;
  font-weight: 700;
  color: var(--color-fg-default);
  margin: 0 0 8px 0;
`;

const EmptyDesc = styled.p`
  font-size: 14px;
  margin: 0;
`;

const EmptyCode = styled.code`
  background-color: var(--color-bg-subtle);
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 13px;
`;

const BAR_COLORS = [
  "#006edb", "#894ceb", "#30a147", "#eb670f",
  "#D97706", "#DC2626", "#059669", "#6366F1",
  "#8B5CF6", "#3B82F6",
];

export default function DashboardClient({ data }: DashboardClientProps) {
  const { users, stats } = data;

  const topUsers = useMemo(() => users.slice(0, 10), [users]);
  const maxTokens = useMemo(() => Math.max(...topUsers.map(u => u.totalTokens), 1), [topUsers]);

  const hasData = stats.totalTokens > 0 || stats.totalCost > 0;

  if (!hasData) {
    return (
      <PageContainer>
        <Navigation />
        <MainContent>
          <EmptyState>
            <EmptyTitle>No usage data yet</EmptyTitle>
            <EmptyDesc>
              Run <EmptyCode>bunx xlab-token@latest submit</EmptyCode> to upload your token usage.
            </EmptyDesc>
          </EmptyState>
        </MainContent>
        <Footer />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <Navigation />

      <MainContent>
        <Title>Token & Usage Dashboard</Title>
        <Subtitle>Aggregate AI token usage across all {stats.uniqueUsers} users</Subtitle>

        {/* Hero stats */}
        <HeroGrid>
          <HeroCard>
            <HeroLabel>Total Tokens</HeroLabel>
            <HeroValue>{formatNumber(stats.totalTokens)}</HeroValue>
            <HeroSub>{stats.uniqueUsers} users</HeroSub>
          </HeroCard>
          <HeroCard>
            <HeroLabel>Total Cost</HeroLabel>
            <HeroValue>{formatCurrency(stats.totalCost)}</HeroValue>
            <HeroSub>{stats.totalSubmissions || 0} submissions</HeroSub>
          </HeroCard>
          <HeroCard>
            <HeroLabel>Top User Tokens</HeroLabel>
            <HeroValue>{topUsers[0] ? formatNumber(topUsers[0].totalTokens) : "—"}</HeroValue>
            <HeroSub>{topUsers[0] ? `@${topUsers[0].username}` : "No data"}</HeroSub>
          </HeroCard>
          <HeroCard>
            <HeroLabel>Top User Cost</HeroLabel>
            <HeroValue>{topUsers[0] ? formatCurrency(topUsers[0].totalCost) : "—"}</HeroValue>
            <HeroSub>{topUsers[0] ? `@${topUsers[0].username}` : "No data"}</HeroSub>
          </HeroCard>
        </HeroGrid>

        {/* Bar chart - top users by tokens */}
        <Card>
          <SectionTitle>Top Users by Tokens</SectionTitle>
          {topUsers.length > 0 ? (
            <BarChartContainer>
              {topUsers.map((u, i) => {
                const heightPct = (u.totalTokens / maxTokens) * 100;
                return (
                  <BarChartBar key={u.userId} $height={heightPct} $color={BAR_COLORS[i % BAR_COLORS.length]}>
                    <BarFill $height={heightPct} $color={BAR_COLORS[i % BAR_COLORS.length]} />
                    <BarLabel>{u.username}</BarLabel>
                  </BarChartBar>
                );
              })}
            </BarChartContainer>
          ) : (
            <ChartEmpty>No data available</ChartEmpty>
          )}
        </Card>

        {/* User list */}
        <Card>
          <SectionTitle>Leaderboard — Top {topUsers.length}</SectionTitle>
          <UserList>
            {topUsers.map((u) => (
              <UserRow key={u.userId} href={`/u/${u.username}`}>
                <RankText>#{u.rank}</RankText>
                {u.avatarUrl && <Avatar src={u.avatarUrl} alt={u.username} />}
                <UserInfo>
                  <UserName>{u.displayName || u.username}</UserName>
                  <UserHandle>@{u.username}</UserHandle>
                </UserInfo>
                <UserStats>
                  <UserStat>
                    <UserStatValue>{formatNumber(u.totalTokens)}</UserStatValue>
                    <UserStatLabel>tokens</UserStatLabel>
                  </UserStat>
                  <UserStat>
                    <UserStatValue>{formatCurrency(u.totalCost)}</UserStatValue>
                    <UserStatLabel>cost</UserStatLabel>
                  </UserStat>
                </UserStats>
              </UserRow>
            ))}
          </UserList>
        </Card>
      </MainContent>

      <Footer />
    </PageContainer>
  );
}
