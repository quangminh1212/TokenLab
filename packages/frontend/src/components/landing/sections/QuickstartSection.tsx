"use client";

import styled from "styled-components";
import { useCopy } from "../hooks";

export function QuickstartSection() {
  const tui = useCopy("bunx xlab-token@latest");
  const submit = useCopy("bunx xlab-token@latest submit");

  return (
    <SectionWrapper>
      <SectionLabel>Quickstart</SectionLabel>
      <CardsRow>
        <Card>
          <CardTitle>View your usage stats</CardTitle>
          <CommandBox>
            <CommandText>bunx xlab-token@latest</CommandText>
            <CopyBtn onClick={tui.copy}>{tui.copied ? "Copied!" : "Copy"}</CopyBtn>
          </CommandBox>
        </Card>
        <Card>
          <CardTitle>Submit to leaderboard</CardTitle>
          <CommandBox>
            <CommandText>bunx xlab-token@latest submit</CommandText>
            <CopyBtn onClick={submit.copy}>{submit.copied ? "Copied!" : "Copy"}</CopyBtn>
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

const CardsRow = styled.div`
  display: flex;
  flex-direction: row;
  gap: 16px;
  width: 100%;
  max-width: 720px;

  @media (max-width: 640px) {
    flex-direction: column;
  }
`;

const Card = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 24px;
  background: var(--color-canvas-default);
  border: 1px solid var(--color-border-default);
  border-radius: 16px;
`;

const CardTitle = styled.h3`
  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 600;
  font-size: 16px;
  color: var(--color-fg-muted);
`;

const CommandBox = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px;
  background: var(--color-canvas-inset);
  border: 1px solid var(--color-border-default);
  border-radius: 10px;
`;

const CommandText = styled.code`
  flex: 1;
  font-family: var(--font-mono), ui-monospace, monospace;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-primary);
  padding: 0 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const CopyBtn = styled.button`
  padding: 8px 16px;
  background: var(--color-primary);
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 700;
  font-size: 14px;
  color: #ffffff;
  flex-shrink: 0;
  transition: opacity 0.15s;

  &:hover { opacity: 0.9; }
`;
