"use client";

import { useMemo } from "react";
import styled from "styled-components";
import { Navigation } from "@/components/layout/Navigation";
import { Footer } from "@/components/layout/Footer";
import { formatNumber, formatCurrency } from "@/lib/utils";
import type { DailyContribution, ClientType } from "@/lib/types";

interface DashboardData {
  user: {
    id: string;
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
    createdAt: string;
    rank: number | null;
  };
  stats: {
    totalTokens: number;
    totalCost: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    submissionCount: number;
    activeDays: number;
    totalActiveTimeMs: number;
    sessionCount: number;
  };
  dateRange: { start: string | null; end: string | null };
  updatedAt: string | null;
  clients: string[];
  models: string[];
  modelUsage?: Array<{ model: string; tokens: number; cost: number; percentage: number }>;
  contributions: DailyContribution[];
}

interface DashboardClientProps {
  data: DashboardData;
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

const HeaderRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 32px;
  flex-wrap: wrap;
  gap: 16px;
`;

const HeaderLeft = styled.div`
  display: flex;
  align-items: center;
  gap: 16px;
`;

const Avatar = styled.img`
  width: 48px;
  height: 48px;
  border-radius: 8px;
  object-fit: cover;
`;

const HeaderInfo = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
`;

const HeaderName = styled.h1`
  font-size: 24px;
  font-weight: 700;
  color: var(--color-fg-default);
  margin: 0;
`;

const HeaderSub = styled.p`
  font-size: 14px;
  color: var(--color-fg-muted);
  margin: 0;
`;

const RankBadge = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 9999px;
  font-size: 14px;
  font-weight: 600;
  background-color: var(--color-badge-bg, rgba(0, 115, 255, 0.1));
  color: var(--color-primary, #006edb);
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

const BreakdownBar = styled.div`
  height: 12px;
  border-radius: 9999px;
  overflow: hidden;
  display: flex;
  margin-bottom: 20px;
  background-color: var(--color-bg-subtle);
`;

const BreakdownSegment = styled.div<{ $width: number; $color: string }>`
  width: ${props => props.$width}%;
  background-color: ${props => props.$color};
  transition: width 0.3s ease;
`;

const BreakdownLegend = styled.div`
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;

  @media (min-width: 768px) {
    grid-template-columns: repeat(4, 1fr);
  }
`;

const LegendItem = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
`;

const LegendDot = styled.div<{ $color: string }>`
  width: 12px;
  height: 12px;
  border-radius: 9999px;
  background-color: ${props => props.$color};
  flex-shrink: 0;
`;

const LegendText = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
`;

const LegendLabel = styled.span`
  font-size: 12px;
  color: var(--color-fg-muted);
`;

const LegendValue = styled.span`
  font-size: 16px;
  font-weight: 700;
  color: var(--color-fg-default);
`;

const LegendPct = styled.span`
  font-size: 11px;
  color: var(--color-fg-subtle);
`;

const ChartContainer = styled.div`
  display: flex;
  align-items: flex-end;
  gap: 4px;
  height: 160px;
  overflow-x: auto;
  padding-bottom: 8px;
`;

const ChartBar = styled.div<{ $height: number; $color: string }>`
  flex: 1;
  min-width: 8px;
  max-width: 40px;
  height: ${props => props.$height}%;
  border-radius: 4px 4px 0 0;
  background-color: ${props => props.$color};
  opacity: ${props => props.$height < 5 ? 0.3 : 1};
  transition: opacity 0.2s;

  &:hover {
    opacity: 1;
  }
`;

const ChartEmpty = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--color-fg-muted);
  font-size: 14px;
`;

const ModelList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
`;

const ModelRow = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
`;

const ModelName = styled.span`
  font-size: 14px;
  font-weight: 600;
  color: var(--color-fg-default);
  min-width: 120px;
`;

const ModelBar = styled.div`
  flex: 1;
  height: 8px;
  border-radius: 9999px;
  background-color: var(--color-bg-subtle);
  overflow: hidden;
`;

const ModelBarFill = styled.div<{ $pct: number; $color: string }>`
  width: ${props => props.$pct}%;
  height: 100%;
  border-radius: 9999px;
  background-color: ${props => props.$color};
`;

const ModelCost = styled.span`
  font-size: 14px;
  font-weight: 600;
  color: var(--color-fg-muted);
  min-width: 80px;
  text-align: right;
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

const EmptyCode = styled.code`
  background-color: var(--color-bg-subtle);
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 13px;
`;

const EmptyDesc = styled.p`
  font-size: 14px;
  margin: 0;
`;

const TwoCol = styled.div`
  display: grid;
  grid-template-columns: 1fr;
  gap: 24px;

  @media (min-width: 768px) {
    grid-template-columns: 1fr 1fr;
  }
`;

const MODEL_COLORS = [
  "#006edb", "#894ceb", "#30a147", "#eb670f",
  "#D97706", "#DC2626", "#059669", "#6366F1",
  "#8B5CF6", "#3B82F6", "#06B6D4", "#F59E0B",
  "#A855F7", "#1A73E8", "#10B981", "#EC4899",
];

export default function DashboardClient({ data }: DashboardClientProps) {
  const { user, stats, contributions, modelUsage } = data;

  const tokenBreakdown = useMemo(() => {
    const total = stats.totalTokens || 0;
    return [
      { label: "Input", value: stats.inputTokens, color: "#006edb", pct: total > 0 ? (stats.inputTokens / total) * 100 : 0 },
      { label: "Output", value: stats.outputTokens, color: "#894ceb", pct: total > 0 ? (stats.outputTokens / total) * 100 : 0 },
      { label: "Cache Read", value: stats.cacheReadTokens, color: "#30a147", pct: total > 0 ? (stats.cacheReadTokens / total) * 100 : 0 },
      { label: "Cache Write", value: stats.cacheWriteTokens, color: "#eb670f", pct: total > 0 ? (stats.cacheWriteTokens / total) * 100 : 0 },
    ];
  }, [stats]);

  const last30Days = useMemo(() => {
    const now = new Date();
    const thirtyAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    return contributions
      .filter(c => new Date(c.date) >= thirtyAgo)
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [contributions]);

  const maxDayCost = useMemo(() => {
    return Math.max(...last30Days.map(d => d.totals.cost), 0);
  }, [last30Days]);

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
        <HeaderRow>
          <HeaderLeft>
            {user.avatarUrl && (
              <Avatar src={user.avatarUrl} alt={`@${user.username}`} />
            )}
            <HeaderInfo>
              <HeaderName>{user.displayName || `@${user.username}`}</HeaderName>
              <HeaderSub>
                {data.dateRange.start && data.dateRange.end
                  ? `${data.dateRange.start} → ${data.dateRange.end}`
                  : "No date range"}
                {data.updatedAt && ` · Updated ${new Date(data.updatedAt).toLocaleDateString()}`}
              </HeaderSub>
            </HeaderInfo>
          </HeaderLeft>
          {user.rank && (
            <RankBadge>#{user.rank} on leaderboard</RankBadge>
          )}
        </HeaderRow>

        {/* Hero stats */}
        <HeroGrid>
          <HeroCard>
            <HeroLabel>Total Tokens</HeroLabel>
            <HeroValue>{formatNumber(stats.totalTokens)}</HeroValue>
            <HeroSub>{stats.activeDays} active days</HeroSub>
          </HeroCard>
          <HeroCard>
            <HeroLabel>Total Cost</HeroLabel>
            <HeroValue>{formatCurrency(stats.totalCost)}</HeroValue>
            <HeroSub>{stats.submissionCount} submissions</HeroSub>
          </HeroCard>
          <HeroCard>
            <HeroLabel>Input Tokens</HeroLabel>
            <HeroValue>{formatNumber(stats.inputTokens)}</HeroValue>
            <HeroSub>{tokenBreakdown[0].pct.toFixed(1)}% of total</HeroSub>
          </HeroCard>
          <HeroCard>
            <HeroLabel>Output Tokens</HeroLabel>
            <HeroValue>{formatNumber(stats.outputTokens)}</HeroValue>
            <HeroSub>{tokenBreakdown[1].pct.toFixed(1)}% of total</HeroSub>
          </HeroCard>
        </HeroGrid>

        {/* Token breakdown */}
        <Card>
          <SectionTitle>Token Breakdown</SectionTitle>
          <BreakdownBar>
            {tokenBreakdown.map(t => (
              <BreakdownSegment
                key={t.label}
                $width={t.pct}
                $color={t.color}
              />
            ))}
          </BreakdownBar>
          <BreakdownLegend>
            {tokenBreakdown.map(t => (
              <LegendItem key={t.label}>
                <LegendDot $color={t.color} />
                <LegendText>
                  <LegendLabel>{t.label}</LegendLabel>
                  <LegendValue>{formatNumber(t.value)}</LegendValue>
                  <LegendPct>{t.pct.toFixed(1)}%</LegendPct>
                </LegendText>
              </LegendItem>
            ))}
          </BreakdownLegend>
        </Card>

        <TwoCol>
          {/* Last 30 days chart */}
          <Card>
            <SectionTitle>Usage (Last 30 Days)</SectionTitle>
            {last30Days.length > 0 ? (
              <ChartContainer>
                {last30Days.map(day => {
                  const heightPct = maxDayCost > 0 ? (day.totals.cost / maxDayCost) * 100 : 0;
                  return (
                    <ChartBar
                      key={day.date}
                      $height={Math.max(heightPct, 2)}
                      $color={day.totals.cost > 0 ? "var(--color-primary, #006edb)" : "var(--color-border-default)"}
                      title={`${day.date}: ${formatCurrency(day.totals.cost)} · ${formatNumber(day.totals.tokens)} tokens`}
                    />
                  );
                })}
              </ChartContainer>
            ) : (
              <ChartEmpty>No usage in the last 30 days</ChartEmpty>
            )}
          </Card>

          {/* Model usage */}
          <Card>
            <SectionTitle>Top Models by Cost</SectionTitle>
            {modelUsage && modelUsage.length > 0 ? (
              <ModelList>
                {modelUsage.slice(0, 6).map((m, i) => (
                  <ModelRow key={m.model}>
                    <ModelName>{m.model}</ModelName>
                    <ModelBar>
                      <ModelBarFill
                        $pct={m.percentage}
                        $color={MODEL_COLORS[i % MODEL_COLORS.length]}
                      />
                    </ModelBar>
                    <ModelCost>{formatCurrency(m.cost)}</ModelCost>
                  </ModelRow>
                ))}
              </ModelList>
            ) : (
              <ChartEmpty>No model data available</ChartEmpty>
            )}
          </Card>
        </TwoCol>
      </MainContent>

      <Footer />
    </PageContainer>
  );
}
