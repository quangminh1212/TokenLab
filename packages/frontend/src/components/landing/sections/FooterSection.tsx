"use client";

import { useEffect, useState } from "react";
import styled from "styled-components";

export function FooterSection() {
  const [currentYear, setCurrentYear] = useState(2026);

  useEffect(() => {
    setCurrentYear(new Date().getFullYear());
  }, []);

  return (
    <FooterWrapper>
      <FooterContent>
        <FooterBrand>
          <BrandName>XLab Token</BrandName>
          <BrandTagline>The Kardashev Scale for AI Devs</BrandTagline>
        </FooterBrand>

        <FooterLinks>
          <FooterColumn>
            <ColumnTitle>Product</ColumnTitle>
            <FooterLink href="/leaderboard">Leaderboard</FooterLink>
            <FooterLink href="/profile">Profile</FooterLink>
            <FooterLink href="/settings">Settings</FooterLink>
          </FooterColumn>
          <FooterColumn>
            <ColumnTitle>Resources</ColumnTitle>
            <FooterLink href="https://github.com/quangminh1212/XLab_Token" target="_blank" rel="noopener noreferrer">GitHub</FooterLink>
            <FooterLink href="https://github.com/quangminh1212/XLab_Token#readme" target="_blank" rel="noopener noreferrer">Documentation</FooterLink>
            <FooterLink href="https://github.com/quangminh1212/XLab_Token/issues" target="_blank" rel="noopener noreferrer">Issues</FooterLink>
          </FooterColumn>
        </FooterLinks>
      </FooterContent>

      <FooterDivider />

      <FooterBottom>
        <Copyright>© {currentYear} XLab Token. All rights reserved.</Copyright>
        <MadeWith>Made with <HeartIcon /> for AI developers</MadeWith>
      </FooterBottom>
    </FooterWrapper>
  );
}

const FooterWrapper = styled.div`
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 32px;
  padding: 64px 24px 40px;
  background: var(--color-canvas-subtle);
  border-top: 1px solid var(--color-border-default);

  @media (max-width: 768px) {
    padding: 48px 16px 32px;
    gap: 24px;
  }
`;

const FooterContent = styled.div`
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  align-items: flex-start;
  max-width: 1080px;
  width: 100%;
  margin: 0 auto;

  @media (max-width: 640px) {
    flex-direction: column;
    gap: 32px;
  }
`;

const FooterBrand = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
`;

const BrandName = styled.span`
  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 800;
  font-size: 20px;
  color: var(--color-fg-default);
`;

const BrandTagline = styled.span`
  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 400;
  font-size: 14px;
  color: var(--color-fg-muted);
`;

const FooterLinks = styled.div`
  display: flex;
  flex-direction: row;
  gap: 64px;

  @media (max-width: 480px) {
    gap: 40px;
  }
`;

const FooterColumn = styled.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
`;

const ColumnTitle = styled.h4`
  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 700;
  font-size: 13px;
  color: var(--color-fg-default);
  margin-bottom: 4px;
`;

const FooterLink = styled.a`
  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 400;
  font-size: 14px;
  color: var(--color-fg-muted);
  text-decoration: none;
  transition: color 0.15s;

  &:hover { color: var(--color-primary); }
`;

const FooterDivider = styled.div`
  width: 100%;
  max-width: 1080px;
  margin: 0 auto;
  height: 1px;
  background: var(--color-border-default);
`;

const FooterBottom = styled.div`
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  max-width: 1080px;
  width: 100%;
  margin: 0 auto;

  @media (max-width: 640px) {
    flex-direction: column;
    gap: 8px;
    text-align: center;
  }
`;

const Copyright = styled.span`
  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 400;
  font-size: 13px;
  color: var(--color-fg-muted);
`;

const MadeWith = styled.span`
  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 400;
  font-size: 13px;
  color: var(--color-fg-muted);
  display: flex;
  align-items: center;
  gap: 4px;
`;

const HeartIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="var(--color-primary)" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 21.35L10.55 20.03C5.4 15.36 2 12.28 2 8.5C2 5.42 4.42 3 7.5 3C9.24 3 10.91 3.81 12 5.09C13.09 3.81 14.76 3 16.5 3C19.58 3 22 5.42 22 8.5C22 12.28 18.6 15.36 13.45 20.04L12 21.35Z"/>
  </svg>
);
