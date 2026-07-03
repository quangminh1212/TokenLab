import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { normalizeUsernameCacheKey } from '@/lib/db/usernameLookup';
import ProfilePageClient from './ProfilePageClient';

export const revalidate = 60;

// In production: use explicit URL or Vercel auto-URL.
// In dev: use 127.0.0.1 to avoid ECONNREFUSED from localhost dual-stack DNS.
function getBaseUrl(): string {
  return process.env.NEXT_PUBLIC_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
    || 'http://127.0.0.1:3000';
}

async function getProfileData(username: string) {
  const res = await fetch(`${getBaseUrl()}/api/users/${username}`, {
    next: { revalidate: 60 },
  });

  if (!res.ok) {
    return null;
  }

  return res.json();
}

// Devices are an enrichment on top of the core profile: if this fetch fails
// we still render the profile, just without the Devices section.
async function getProfileDevices(username: string) {
  try {
    const res = await fetch(`${getBaseUrl()}/api/users/${username}/devices`, {
      // Tagged so PATCH /api/settings/devices/[deviceId] (rename) can
      // invalidate this immediately via revalidateTag(`user:...`) instead of
      // waiting out the 60s revalidate window.
      next: {
        revalidate: 60,
        tags: [`user:${normalizeUsernameCacheKey(username)}`],
      },
    });

    if (!res.ok) {
      return [];
    }

    const data = await res.json();
    return Array.isArray(data.devices) ? data.devices : [];
  } catch {
    return [];
  }
}

export async function generateMetadata({ params }: { params: Promise<{ username: string }> }): Promise<Metadata> {
  const { username } = await params;
  return {
    title: `@${username} - Token Usage | XLab Token`,
    description: `View ${username}'s AI token usage statistics and cost breakdown on XLab Token`,
    openGraph: {
      title: `@${username}'s Token Usage | XLab Token`,
      description: `AI token usage statistics for ${username} on XLab Token`,
      type: 'profile',
      url: `https://xlab-token.ai/u/${username}`,
      siteName: 'XLab Token',
      images: [
        {
          url: 'https://xlab-token.ai/og-image.png',
          width: 1200,
          height: 630,
          alt: `${username}'s Token Usage on XLab Token`,
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: `@${username}'s Token Usage | XLab Token`,
      images: ['https://xlab-token.ai/og-image.png'],
    },
  };
}

export default async function ProfilePage({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  const [data, devices] = await Promise.all([
    getProfileData(username),
    getProfileDevices(username),
  ]);

  if (!data) {
    notFound();
  }

  if (data.user?.username && data.user.username !== username) {
    permanentRedirect(`/u/${data.user.username}`);
  }

  return <ProfilePageClient initialData={data} initialDevices={devices} username={username} />;
}
