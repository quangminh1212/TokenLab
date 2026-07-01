"use client";

import styled from "styled-components";

export function DashboardSection() {
  return (
    <SectionWrapper>
      <SectionLabel>Dashboard</SectionLabel>
      <Card>
        <CardTitle>View Your Usage</CardTitle>
        <CardDescription>
          Track your token usage across AI coding assistants. View detailed statistics, costs, and usage patterns.
        </CardDescription>
        <DashboardButton href="/profile">
          Go to Dashboard
        </DashboardButton>
      </Card>
    </SectionWrapper>
  );
}

const SectionWrapper = styled.div`
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 32px;
  padding: 64px 24px;

  @media (max-width: 768px) {
    padding: 40px 16px;
    gap: 24px;
  }
`;

const SectionLabel = styled.h2`
  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 700;
  font-size: 24px;
  color: var(--color-fg-default);
`;

const Card = styled.div`
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 32px;
  background: var(--color-canvas-default);
  border: 1px solid var(--color-border-default);
  border-radius: 16px;
  max-width: 640px;
  width: 100%;
`;

const CardTitle = styled.h3`
  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 700;
  font-size: 20px;
  color: var(--color-fg-default);
`;

const CardDescription = styled.p`
  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 400;
  font-size: 16px;
  line-height: 1.5em;
  color: var(--color-fg-muted);
`;

const DashboardButton = styled.a`
  display: inline-flex;
  justify-content: center;
  align-items: center;
  padding: 12px 24px;
  background: var(--color-primary);
  border: none;
  border-radius: 10px;
  cursor: pointer;
  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 700;
  font-size: 16px;
  color: #ffffff;
  text-decoration: none;
  transition: opacity 0.15s;
  align-self: flex-start;

  &:hover { opacity: 0.9; }
`;
