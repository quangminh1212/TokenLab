import { Navigation } from "@/components/layout/Navigation";
import { LandingPage } from "@/components/landing/LandingPage";
import { getStargazersCount } from "@/lib/github";

export default async function HomePage() {
  const stargazersCount = await getStargazersCount("quangminh1212/XLab_Token");

  return (
    <>
      <Navigation />
      <LandingPage
        stargazersCount={stargazersCount}
      />
    </>
  );
}
