"use client";

import styled from "styled-components";
import { useCopy } from "../hooks";

export function QuickstartSection() {
  const tui = useCopy("bunx xlab-token@latest");
  const submit = useCopy("bunx xlab-token@latest submit");
  const login = useCopy("bunx xlab-token@latest login");

  return (
    <SectionWrapper>
      <SectionHeader>
        <SectionLabel>Quickstart</SectionLabel>
        <SectionSublabel>Get started in seconds — no installation required</SectionSublabel>
      </SectionHeader>
      <CardsRow>
        <Card>
          <CardIcon>
            <ChartIcon />
          </CardIcon>
          <CardTitle>View your usage stats</CardTitle>
          <CardDesc>Launch the interactive TUI dashboard to see your token usage across all AI coding tools.</CardDesc>
          <CommandBox>
            <CommandPrompt>$</CommandPrompt>
            <CommandText>bunx xlab-token@latest</CommandText>
            <CopyBtn onClick={tui.copy}>{tui.copied ? "✓" : "Copy"}</CopyBtn>
          </CommandBox>
        </Card>

        <Card>
          <CardIcon>
            <TrophyIcon />
          </CardIcon>
          <CardTitle>Submit to leaderboard</CardTitle>
          <CardDesc>Push your usage data to the global leaderboard and compete with other AI developers worldwide.</CardDesc>
          <CommandBox>
            <CommandPrompt>$</CommandPrompt>
            <CommandText>bunx xlab-token@latest submit</CommandText>
            <CopyBtn onClick={submit.copy}>{submit.copied ? "✓" : "Copy"}</CopyBtn>
          </CommandBox>
        </Card>

        <Card>
          <CardIcon>
            <KeyIcon />
          </CardIcon>
          <CardTitle>Link your account</CardTitle>
          <CardDesc>Authenticate with GitHub to claim your profile and sync your submissions across devices.</CardDesc>
          <CommandBox>
            <CommandPrompt>$</CommandPrompt>
            <CommandText>bunx xlab-token@latest login</CommandText>
            <CopyBtn onClick={login.copy}>{login.copied ? "✓" : "Copy"}</CopyBtn>
          </CommandBox>
        </Card>
      </CardsRow>
    </SectionWrapper>
  );
}

const SectionWrapper = styled.div`
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 40px;
  padding: 80px 24px;

  @media (max-width: 768px) {
    padding: 48px 16px;
    gap: 28px;
  }
`;

const SectionHeader = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
`;

const SectionLabel = styled.h2`
  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 800;
  font-size: 32px;
  letter-spacing: -0.02em;
  color: var(--color-fg-default);

  @media (max-width: 480px) {
    font-size: 24px;
  }
`;

const SectionSublabel = styled.p`
  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 400;
  font-size: 16px;
  color: var(--color-fg-muted);
`;

const CardsRow = styled.div`
  display: flex;
  flex-direction: row;
  gap: 16px;
  width: 100%;
  max-width: 880px;

  @media (max-width: 880px) {
    flex-direction: column;
  }
`;

const Card = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 28px;
  background: var(--color-canvas-default);
  border: 1px solid var(--color-border-default);
  border-radius: 20px;
  transition: all 0.2s;

  &:hover {
    border-color: color-mix(in srgb, var(--color-primary) 30%, var(--color-border-default));
    box-shadow: 0 8px 32px rgba(0, 161, 154, 0.06);
    transform: translateY(-2px);
  }
`;

const CardIcon = styled.div`
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-badge-bg);
  border-radius: 12px;
  margin-bottom: 4px;
`;

const ChartIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 3V21H21" stroke="var(--color-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M7 14L11 10L15 14L21 8" stroke="var(--color-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const TrophyIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M6 4H18V6C18 8.20914 16.2091 10 14 10H10C7.79086 10 6 8.20914 6 6V4Z" stroke="var(--color-primary)" strokeWidth="2" strokeLinejoin="round"/>
    <path d="M6 5H3V7C3 8.65685 4.34315 10 6 10" stroke="var(--color-primary)" strokeWidth="2" strokeLinecap="round"/>
    <path d="M18 5H21V7C21 8.65685 19.6569 10 18 10" stroke="var(--color-primary)" strokeWidth="2" strokeLinecap="round"/>
    <path d="M12 10V14M9 18H15M8 21H16" stroke="var(--color-primary)" strokeWidth="2" strokeLinecap="round"/>
  </svg>
);

const KeyIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="8" cy="15" r="4" stroke="var(--color-primary)" strokeWidth="2"/>
    <path d="M10.85 12.15L19 4M18 5L20 7M15 8L17 10" stroke="var(--color-primary)" strokeWidth="2" strokeLinecap="round"/>
  </svg>
);

const CardTitle = styled.h3`
  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 700;
  font-size: 17px;
  color: var(--color-fg-default);
`;

const CardDesc = styled.p`
  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 400;
  font-size: 14px;
  line-height: 1.5em;
  color: var(--color-fg-muted);
  flex: 1;
`;

const CommandBox = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 6px 6px 12px;
  background: var(--color-canvas-inset);
  border: 1px solid var(--color-border-default);
  border-radius: 12px;
`;

const CommandPrompt = styled.span`
  font-family: var(--font-mono), ui-monospace, monospace;
  font-weight: 600;
  font-size: 13px;
  color: var(--color-fg-subtle);
  flex-shrink: 0;
`;

const CommandText = styled.code`
  flex: 1;
  font-family: var(--font-mono), ui-monospace, monospace;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-primary);
  padding: 0 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const CopyBtn = styled.button`
  padding: 7px 14px;
  background: var(--color-primary);
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 700;
  font-size: 13px;
  color: #ffffff;
  flex-shrink: 0;
  transition: all 0.15s;

  &:hover { opacity: 0.9; }
`;
