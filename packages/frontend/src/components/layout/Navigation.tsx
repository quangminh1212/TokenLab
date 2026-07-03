"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import styled, { css, keyframes } from "styled-components";

const MOBILE_BREAKPOINT = "520px";

const pulse = keyframes`
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
`;

const NavContainer = styled.nav`
  position: fixed;
  top: 17px;
  left: 50%;
  transform: translateX(-50%);
  height: 40px;
  background: var(--color-card-bg);
  backdrop-filter: blur(10px);
  border: 1px solid var(--color-border-default);
  border-radius: 32px;
  padding: 4px;
  display: flex;
  align-items: center;
  gap: 4px;
  z-index: 50;
  
  @media (max-width: 767px) {
    max-width: 100%;
    gap: 2px;
  }

  @media (max-width: ${MOBILE_BREAKPOINT}) {
    left: 16px;
    right: 16px;
    transform: none;
    width: calc(100% - 32px);
    height: auto;
    flex-direction: column;
    align-items: stretch;
    border-radius: 20px;
    overflow: hidden;
    border: 1px solid var(--color-border-default);
    background: var(--color-card-bg);
  }
`;

const NavHeaderRow = styled.div`
  display: contents;

  @media (max-width: ${MOBILE_BREAKPOINT}) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    height: 40px;
    flex-shrink: 0;
  }
`;

const NavItemBase = styled.a<{ $isActive: boolean }>`
  font-family: 'Figtree', sans-serif;
  font-weight: 700;
  font-size: 16px;
  text-transform: uppercase;
  padding: 8px 23px;
  border-radius: 1000px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  text-decoration: none;
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
  min-width: 0;
  
  @media (max-width: 767px) {
    padding: 8px 10px;
  }
  
  ${({ $isActive }) =>
    $isActive
      ? css`
    background: var(--color-primary);
    border: 1px solid var(--color-primary);
    color: #ffffff;
  `
      : css`
    background: transparent;
    border: 1px solid transparent;
    color: var(--color-fg-muted);
    
    &:hover {
      color: var(--color-fg-default);
    }
  `}
`;

const NavItemLink = styled(Link)<{ $isActive: boolean }>`
  font-family: 'Figtree', sans-serif;
  font-weight: 700;
  font-size: 16px;
  text-transform: uppercase;
  padding: 8px 23px;
  border-radius: 1000px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  text-decoration: none;
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
  min-width: 0;
  
  @media (max-width: 767px) {
    padding: 8px 10px;
  }
  
  ${({ $isActive }) =>
    $isActive
      ? css`
    background: var(--color-primary);
    border: 1px solid var(--color-primary);
    color: #ffffff;
  `
      : css`
    background: transparent;
    border: 1px solid transparent;
    color: var(--color-fg-muted);
    
    &:hover {
      color: var(--color-fg-default);
    }
  `}
`;

const LoadingSkeleton = styled.div`
  width: 32px;
  height: 32px;
  border-radius: 1000px;
  animation: ${pulse} 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  background-color: var(--color-btn-hover-bg);
  flex-shrink: 0;
`;

const DisplayName = styled.p`
  font-size: 14px;
  font-weight: 500;
  color: var(--color-fg-default, #e6edf3);
`;
const Username = styled.p`
  font-size: 12px;
  color: var(--color-fg-muted, #848d97);
`;

const SignInButton = styled.a`
  display: flex;
  flex-direction: row;
  justify-content: center;
  align-items: center;
  padding: 6px 10px 6px 6px;
  gap: 8px;
  height: 32px;
  background: var(--color-primary);
  border-radius: 1000px;
  text-decoration: none;
  cursor: pointer;
  transition: opacity 0.15s ease;
  flex-shrink: 0;
  
  &:hover {
    opacity: 0.9;
  }
  
  @media (max-width: 374px) {
    padding: 6px;
    gap: 4px;
  }
`;

const SignInIcon = styled.div`
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
`;

const SignInText = styled.span`
  font-family: var(--font-figtree), 'Figtree', sans-serif;
  font-weight: 700;
  font-size: 14px;
  line-height: 94%;
  text-align: center;
  letter-spacing: -0.05em;
  color: #FFFFFF;
  white-space: nowrap;
`;

const SignInTextFull = styled(SignInText)`
  @media (max-width: 767px) {
    display: none;
  }
`;

const SignInTextCompact = styled(SignInText)`
  @media (min-width: 768px) {
    display: none;
  }
`;

const ProfileButton = styled.button`
  box-sizing: border-box;
  display: flex;
  justify-content: center;
  align-items: center;
  width: 32px;
  height: 32px;
  background: var(--color-primary);
  border: 1px solid var(--color-primary);
  border-radius: 1000px;
  padding: 0;
  cursor: pointer;
  overflow: hidden;
  transition: opacity 0.15s ease;
  flex-shrink: 0;
  
  &:hover {
    opacity: 0.9;
  }
`;

const MenuWrapper = styled.div`
  position: relative;
`;

const MenuOverlay = styled.div`
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  width: 220px;
  background: var(--color-card-bg);
  border: 1px solid var(--color-border-default);
  border-radius: 12px;
  overflow: hidden;
  z-index: 100;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4);
`;

const MenuUserInfo = styled.div`
  padding: 12px;
  border-bottom: 1px solid var(--color-border-default, #30363d);
`;

const MenuDivider = styled.div`
  height: 1px;
  background: var(--color-border-default, #30363d);
`;

const MenuItem = styled(Link)<{ $danger?: boolean }>`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 14px;
  color: ${({ $danger }) => $danger ? '#F85149' : 'var(--color-fg-default, #e6edf3)'};
  text-decoration: none;
  cursor: pointer;
  transition: background 150ms;
  &:hover {
    background: ${({ $danger }) => $danger ? 'rgba(248, 81, 73, 0.1)' : 'rgba(255, 255, 255, 0.05)'};
  }
`;

const MenuItemButton = styled.button<{ $danger?: boolean }>`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 14px;
  width: 100%;
  color: ${({ $danger }) => $danger ? '#F85149' : 'var(--color-fg-default, #e6edf3)'};
  text-decoration: none;
  cursor: pointer;
  transition: background 150ms;
  background: none;
  border: none;
  text-align: left;
  &:hover {
    background: ${({ $danger }) => $danger ? 'rgba(248, 81, 73, 0.1)' : 'rgba(255, 255, 255, 0.05)'};
  }
`;

const MenuIconSlot = styled.span`
  display: flex;
  align-items: center;
  color: var(--color-fg-muted, #848d97);
`;

const AvatarImg = styled.img`
  border-radius: 50%;
  object-fit: cover;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.1);
`;

const DesktopNavItems = styled.div`
  display: contents;

  @media (max-width: ${MOBILE_BREAKPOINT}) {
    display: none;
  }
`;

const DesktopAuthSection = styled.div`
  display: contents;

  @media (max-width: ${MOBILE_BREAKPOINT}) {
    display: none;
  }
`;

const NavLogoLink = styled(Link)`
  display: none;
  flex-shrink: 0;

  @media (max-width: ${MOBILE_BREAKPOINT}) {
    padding-left: 8px;
    display: flex;
  }
`;

const NavLogoImage = styled(Image)`
  object-fit: contain;
`;

const HamburgerButton = styled.button`
  display: none;
  width: 32px;
  height: 32px;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--color-fg-muted);
  cursor: pointer;
  padding: 0;
  flex-shrink: 0;
  border-radius: 1000px;
  transition: color 0.15s ease;

  &:hover {
    color: var(--color-fg-default);
  }

  @media (max-width: ${MOBILE_BREAKPOINT}) {
    display: flex;
  }
`;


const MobileDropdownWrapper = styled.div<{ $isOpen: boolean }>`
  display: none;

  @media (max-width: ${MOBILE_BREAKPOINT}) {
    display: block;
    max-height: ${({ $isOpen }) => ($isOpen ? "500px" : "0")};
    overflow: hidden;
    transition: max-height 0.25s ease-in-out;
  }
`;

const MobileDropdown = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 4px;
  border-top: 1px solid var(--color-border-subtle);
  width: 100%;
`;

const DropdownNavLink = styled(Link)<{ $isActive: boolean }>`
  font-family: var(--font-figtree), 'Figtree', sans-serif;
  font-weight: 700;
  font-size: 15px;
  text-transform: uppercase;
  text-decoration: none;
  padding: 10px 16px;
  border-radius: 12px;
  display: block;
  transition: all 0.15s ease;

  ${({ $isActive }) =>
    $isActive
      ? css`
    background: var(--color-badge-bg);
    color: var(--color-fg-default);
  `
      : css`
    background: transparent;
    color: var(--color-fg-muted);

    &:hover {
      color: var(--color-fg-default);
      background: var(--color-btn-hover-bg);
    }
  `}
`;

const DropdownNavLinkExternal = styled.a<{ $isActive: boolean }>`
  font-family: var(--font-figtree), 'Figtree', sans-serif;
  font-weight: 700;
  font-size: 15px;
  text-transform: uppercase;
  text-decoration: none;
  padding: 10px 16px;
  border-radius: 12px;
  display: block;
  transition: all 0.15s ease;

  ${({ $isActive }) =>
    $isActive
      ? css`
    background: var(--color-badge-bg);
    color: var(--color-fg-default);
  `
      : css`
    background: transparent;
    color: var(--color-fg-muted);

    &:hover {
      color: var(--color-fg-default);
      background: var(--color-btn-hover-bg);
    }
  `}
`;

const DropdownDivider = styled.div`
  height: 1px;
  background: var(--color-border-subtle);
  margin: 4px 8px;
`;

const DropdownSignInButton = styled.a`
  display: flex;
  flex-direction: row;
  justify-content: center;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 40px;
  background: var(--color-primary);
  border-radius: 12px;
  text-decoration: none;
  cursor: pointer;
  transition: opacity 0.15s ease;
  margin: 0 0 4px;

  &:hover {
    opacity: 0.9;
  }
`;

const DropdownSignInText = styled.span`
  font-family: var(--font-figtree), 'Figtree', sans-serif;
  font-weight: 700;
  font-size: 14px;
  color: #ffffff;
`;

const DropdownUserCard = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
`;

const DropdownUserDetails = styled.div`
  flex: 1;
  min-width: 0;
`;

const DropdownDisplayName = styled.p`
  font-family: var(--font-figtree), 'Figtree', sans-serif;
  font-weight: 600;
  font-size: 14px;
  color: var(--color-fg-default);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const DropdownUsername = styled.p`
  font-size: 12px;
  color: var(--color-fg-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const DropdownUserAction = styled(Link)`
  font-family: var(--font-figtree), 'Figtree', sans-serif;
  font-weight: 500;
  font-size: 14px;
  color: var(--color-fg-muted);
  text-decoration: none;
  padding: 10px 16px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  gap: 10px;
  transition: all 0.15s ease;

  &:hover {
    color: var(--color-fg-default);
    background: var(--color-btn-hover-bg);
 }

  svg {
    color: var(--color-fg-subtle);
    flex-shrink: 0;
  }
`;

const DropdownSignOutButton = styled.button`
  font-family: var(--font-figtree), 'Figtree', sans-serif;
  font-weight: 500;
  font-size: 14px;
  color: #F85149;
  background: transparent;
  border: none;
  padding: 10px 16px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  cursor: pointer;
  transition: all 0.15s ease;

  &:hover {
    background: rgba(248, 81, 73, 0.1);
  }

  svg {
    color: #F85149;
    flex-shrink: 0;
  }
`;

const GitHubIcon = () => (
  <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 0C5.374 0 0 5.373 0 12C0 17.302 3.438 21.8 8.207 23.387C8.806 23.498 9 23.126 9 22.81V20.576C5.662 21.302 4.967 19.16 4.967 19.16C4.421 17.773 3.634 17.404 3.634 17.404C2.545 16.659 3.717 16.675 3.717 16.675C4.922 16.759 5.556 17.912 5.556 17.912C6.626 19.746 8.363 19.216 9.048 18.909C9.155 18.134 9.466 17.604 9.81 17.305C7.145 17 4.343 15.971 4.343 11.374C4.343 10.063 4.812 8.993 5.579 8.153C5.455 7.85 5.044 6.629 5.696 4.977C5.696 4.977 6.704 4.655 8.997 6.207C9.954 5.941 10.98 5.808 12 5.803C13.02 5.808 14.047 5.941 15.006 6.207C17.297 4.655 18.303 4.977 18.303 4.977C18.956 6.63 18.545 7.851 18.421 8.153C19.19 8.993 19.656 10.064 19.656 11.374C19.656 15.983 16.849 16.998 14.177 17.295C14.607 17.667 15 18.397 15 19.517V22.81C15 23.129 15.192 23.504 15.801 23.386C20.566 21.797 24 17.3 24 12C24 5.373 18.627 0 12 0Z" fill="white"/>
  </svg>
);

const MenuIcon = () => (
  <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 12H21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M3 6H21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M3 18H21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const CloseIcon = () => (
  <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M6 6L18 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

export function Navigation() {
  const pathname = usePathname();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  const closeMobileMenu = () => setIsMobileMenuOpen(false);

  return (
    <NavContainer aria-label="Main navigation">
      <NavHeaderRow>
        <NavLogoLink href="/" aria-label="XLab Token home">
          <NavLogoImage
            src="/assets/hero-logo.svg"
            alt="XLab Token"
            width={80}
            height={32}
            priority
          />
        </NavLogoLink>

        <HamburgerButton
          onClick={() => setIsMobileMenuOpen((prev) => !prev)}
          aria-label={isMobileMenuOpen ? "Close menu" : "Open menu"}
        >
          {isMobileMenuOpen ? <CloseIcon /> : <MenuIcon />}
        </HamburgerButton>

        <DesktopNavItems>
          <NavItemLink href="/" $isActive={pathname === "/"}>
            About
          </NavItemLink>
          <NavItemLink href="/dashboard" $isActive={pathname === "/dashboard" || pathname.startsWith("/u/")}>
            Dashboard
          </NavItemLink>
          <NavItemLink href="/settings" $isActive={pathname === "/settings"}>
            Settings
          </NavItemLink>
          <NavItemBase
            as="a"
            href="https://github.com/quangminh1212/XLab_Token"
            target="_blank"
            rel="noopener noreferrer"
            $isActive={false}
          >
            GitHub
          </NavItemBase>
        </DesktopNavItems>
      </NavHeaderRow>


      <MobileDropdownWrapper $isOpen={isMobileMenuOpen}>
        <MobileDropdown>
          <DropdownNavLink href="/" $isActive={pathname === "/"} onClick={closeMobileMenu}>
            About
          </DropdownNavLink>
          <DropdownNavLink href="/dashboard" $isActive={pathname === "/dashboard" || pathname.startsWith("/u/")} onClick={closeMobileMenu}>
            Dashboard
          </DropdownNavLink>
          <DropdownNavLink href="/settings" $isActive={pathname === "/settings"} onClick={closeMobileMenu}>
            Settings
          </DropdownNavLink>
          <DropdownNavLinkExternal
            href="https://github.com/quangminh1212/XLab_Token"
            target="_blank"
            rel="noopener noreferrer"
            $isActive={false}
            onClick={closeMobileMenu}
          >
            GitHub ↗
          </DropdownNavLinkExternal>
        </MobileDropdown>
      </MobileDropdownWrapper>
    </NavContainer>
  );
}
