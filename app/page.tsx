import Hero from './components/Landing/Hero';
import Stats from './components/Landing/Stats';
import Categories from './components/Landing/Categories';
import HowItWorks from './components/Landing/HowItWorks';
import Trending from './components/Landing/Trending';
import CTA from './components/Landing/CTA';
import Footer from './components/Landing/Footer';

export const metadata = {
  title: 'HackAss - Life hacks that don\'t suck',
  description: 'Crowdsourced life hacks voted by real people. No fluff, no SEO intros.',
};

export default function Home() {
  return (
    <main className="bg-black">
      <Hero />
      <Stats />
      <Categories />
      <HowItWorks />
      <Trending />
      <CTA />
      <Footer />
    </main>
  );
}
