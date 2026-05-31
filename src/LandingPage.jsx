import { useEffect } from 'react';

const C = {
  bg:      '#0C0B1A',
  surface: '#161429',
  border:  'rgba(255,255,255,0.08)',
  amber:   '#F5A623',
  teal:    '#0FB8A9',
  text:    '#EDE9F5',
  muted:   '#9B97B0',
};

const DEMO_EMAIL = 'hello@vaaksetu.ai';

function navigate(path) {
  window.location.href = path;
}

export function LandingPage() {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'auto';
    document.title = 'VaakSetu — Multilingual Communication Engine';
    return () => { document.body.style.overflow = prev; };
  }, []);

  return (
    <div style={{ background: C.bg, color: C.text, fontFamily: '"DM Sans", system-ui, sans-serif', minHeight: '100vh' }}>
      <style>{`
        .vs-btn-primary {
          background: ${C.amber}; color: #0C0B1A; border: none;
          padding: 14px 32px; border-radius: 8px; font-size: 16px;
          font-weight: 600; cursor: pointer; font-family: inherit;
          transition: opacity 0.15s, transform 0.15s;
          display: inline-block; text-decoration: none;
        }
        .vs-btn-primary:hover { opacity: 0.88; transform: translateY(-1px); }
        .vs-btn-outline {
          background: transparent; color: ${C.text};
          border: 1.5px solid rgba(255,255,255,0.25);
          padding: 13px 32px; border-radius: 8px; font-size: 16px;
          font-weight: 500; cursor: pointer; font-family: inherit;
          transition: border-color 0.15s, transform 0.15s;
          display: inline-block; text-decoration: none;
        }
        .vs-btn-outline:hover { border-color: ${C.amber}; transform: translateY(-1px); }
        .vs-card {
          background: ${C.surface}; border: 1px solid ${C.border};
          border-radius: 12px; padding: 28px;
        }
        .vs-section { max-width: 1080px; margin: 0 auto; padding: 80px 24px; }
        .vs-section-sm { max-width: 1080px; margin: 0 auto; padding: 60px 24px; }
        .vs-grid-3 { display: grid; grid-template-columns: repeat(3,1fr); gap: 20px; }
        .vs-grid-2 { display: grid; grid-template-columns: repeat(2,1fr); gap: 24px; }
        .vs-grid-features { display: grid; grid-template-columns: repeat(3,1fr); gap: 20px; }
        @media (max-width: 768px) {
          .vs-grid-3 { grid-template-columns: 1fr; }
          .vs-grid-2 { grid-template-columns: 1fr; }
          .vs-grid-features { grid-template-columns: 1fr; }
          .vs-hero-btns { flex-direction: column; align-items: stretch !important; }
          .vs-hero-btns a, .vs-hero-btns button { text-align: center; }
          .vs-section { padding: 60px 20px; }
          .vs-nav-cta { display: none !important; }
        }
      `}</style>

      {/* ── Nav ─────────────────────────────────────────────── */}
      <nav style={{ position: 'sticky', top: 0, zIndex: 100, background: 'rgba(12,11,26,0.92)', backdropFilter: 'blur(12px)', borderBottom: `1px solid ${C.border}` }}>
        <div style={{ maxWidth: 1080, margin: '0 auto', padding: '0 24px', height: 64, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontFamily: '"Crimson Pro", serif', fontSize: 22, fontWeight: 700, color: C.amber }}>VaakSetu</span>
            <span style={{ fontSize: 11, background: 'rgba(245,166,35,0.15)', color: C.amber, padding: '2px 8px', borderRadius: 20, fontWeight: 500, letterSpacing: '0.04em' }}>BETA</span>
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <button className="vs-btn-outline vs-nav-cta" style={{ padding: '8px 20px', fontSize: 14 }} onClick={() => navigate('/app')}>
              Try Live
            </button>
            <a className="vs-btn-primary" style={{ padding: '8px 20px', fontSize: 14 }} href={`mailto:${DEMO_EMAIL}?subject=Demo Request — VaakSetu`}>
              Book a Demo
            </a>
          </div>
        </div>
      </nav>

      {/* ── Hero ────────────────────────────────────────────── */}
      <section style={{ maxWidth: 1080, margin: '0 auto', padding: '100px 24px 80px', textAlign: 'center' }}>
        <div style={{ display: 'inline-block', background: 'rgba(15,184,169,0.12)', color: C.teal, padding: '6px 16px', borderRadius: 20, fontSize: 13, fontWeight: 500, marginBottom: 28, border: `1px solid rgba(15,184,169,0.2)` }}>
          Multilingual Communication Engine
        </div>
        <h1 style={{ fontFamily: '"Crimson Pro", serif', fontSize: 'clamp(40px, 6vw, 72px)', fontWeight: 700, lineHeight: 1.1, marginBottom: 24, letterSpacing: '-0.01em' }}>
          Your next big deal shouldn't fail<br />
          <span style={{ color: C.amber }}>because of language.</span>
        </h1>
        <p style={{ fontSize: 'clamp(16px, 2vw, 20px)', color: C.muted, maxWidth: 640, margin: '0 auto 40px', lineHeight: 1.6 }}>
          VaakSetu lets your team speak directly with any buyer, customer, or partner — in their language, live, without an interpreter.
        </p>
        <div className="vs-hero-btns" style={{ display: 'flex', gap: 16, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button className="vs-btn-primary" style={{ fontSize: 17, padding: '16px 40px' }} onClick={() => navigate('/app')}>
            Try It Live — Free
          </button>
          <a className="vs-btn-outline" style={{ fontSize: 17, padding: '16px 40px' }} href={`mailto:${DEMO_EMAIL}?subject=Demo Request — VaakSetu`}>
            Book a 20-min Demo
          </a>
        </div>
        <p style={{ marginTop: 20, fontSize: 13, color: C.muted }}>No download. No credit card. Works on any phone.</p>

        {/* Language pill strip */}
        <div style={{ marginTop: 56, display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'center' }}>
          {['हिंदी','English','日本語','العربية','한국어','Español','தமிழ்','Français','বাংলা','Deutsch','ਪੰਜਾਬੀ','中文'].map(lang => (
            <span key={lang} style={{ background: C.surface, border: `1px solid ${C.border}`, padding: '5px 14px', borderRadius: 20, fontSize: 13, color: C.muted }}>
              {lang}
            </span>
          ))}
          <span style={{ background: C.surface, border: `1px solid ${C.border}`, padding: '5px 14px', borderRadius: 20, fontSize: 13, color: C.muted }}>
            +17 more
          </span>
        </div>
      </section>

      {/* ── Pain ─────────────────────────────────────────────── */}
      <section style={{ background: C.surface, borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}` }}>
        <div className="vs-section">
          <div style={{ textAlign: 'center', marginBottom: 48 }}>
            <h2 style={{ fontFamily: '"Crimson Pro", serif', fontSize: 'clamp(28px, 4vw, 44px)', fontWeight: 700, marginBottom: 12 }}>
              How much business are you losing today?
            </h2>
            <p style={{ color: C.muted, fontSize: 17 }}>Language barriers don't just cause confusion. They cost you revenue.</p>
          </div>
          <div className="vs-grid-3">
            {[
              {
                icon: '🇯🇵',
                title: 'The buyer who stopped responding',
                body: 'Not because the deal was bad. Because every call needed a middleman — and trust never built.',
              },
              {
                icon: '🏦',
                title: 'The customer who went to a competitor',
                body: "Your branch manager couldn't explain the product in his language. He walked out and never came back.",
              },
              {
                icon: '🇦🇪',
                title: 'The importer who chose someone else',
                body: 'They felt more comfortable with someone who spoke their language — even if your price was better.',
              },
            ].map(({ icon, title, body }) => (
              <div key={title} className="vs-card" style={{ borderTop: `3px solid ${C.amber}` }}>
                <div style={{ fontSize: 32, marginBottom: 16 }}>{icon}</div>
                <h3 style={{ fontFamily: '"Crimson Pro", serif', fontSize: 20, fontWeight: 600, marginBottom: 10, lineHeight: 1.3 }}>{title}</h3>
                <p style={{ color: C.muted, fontSize: 15, lineHeight: 1.6 }}>{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Solution ─────────────────────────────────────────── */}
      <section className="vs-section" style={{ textAlign: 'center' }}>
        <div style={{ display: 'inline-block', background: 'rgba(245,166,35,0.1)', color: C.amber, padding: '6px 16px', borderRadius: 20, fontSize: 13, fontWeight: 500, marginBottom: 24, border: `1px solid rgba(245,166,35,0.2)` }}>
          How it works
        </div>
        <h2 style={{ fontFamily: '"Crimson Pro", serif', fontSize: 'clamp(28px, 4vw, 44px)', fontWeight: 700, marginBottom: 20 }}>
          VaakSetu removes the barrier.<br /><span style={{ color: C.teal }}>The relationship stays.</span>
        </h2>
        <p style={{ color: C.muted, fontSize: 17, maxWidth: 620, margin: '0 auto 56px', lineHeight: 1.7 }}>
          Speak in Hindi. Your buyer hears Japanese. They respond in Japanese. You hear Hindi.
          Live. No delays. No interpreter. No awkward pauses.
        </p>

        {/* 3-step flow */}
        <div className="vs-grid-3" style={{ textAlign: 'left', marginBottom: 56 }}>
          {[
            { num: '01', title: 'Open VaakSetu', body: 'On your phone or laptop. No download, no installation — works in any browser.' },
            { num: '02', title: 'Share a link', body: 'Your buyer or customer joins from their device, anywhere in the world.' },
            { num: '03', title: 'Speak naturally', body: 'VaakSetu translates both sides in real time. You both hear your own language.' },
          ].map(({ num, title, body }) => (
            <div key={num} className="vs-card" style={{ position: 'relative', overflow: 'hidden' }}>
              <div style={{ fontFamily: '"Crimson Pro", serif', fontSize: 64, fontWeight: 700, color: 'rgba(245,166,35,0.08)', position: 'absolute', top: -8, right: 16, lineHeight: 1 }}>{num}</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.amber, marginBottom: 10, letterSpacing: '0.06em' }}>{num}</div>
              <h3 style={{ fontFamily: '"Crimson Pro", serif', fontSize: 21, fontWeight: 600, marginBottom: 10 }}>{title}</h3>
              <p style={{ color: C.muted, fontSize: 15, lineHeight: 1.6 }}>{body}</p>
            </div>
          ))}
        </div>

        <button className="vs-btn-primary" style={{ fontSize: 16, padding: '15px 40px' }} onClick={() => navigate('/app')}>
          See It In Action →
        </button>
      </section>

      {/* ── Verticals ────────────────────────────────────────── */}
      <section style={{ background: C.surface, borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}` }}>
        <div className="vs-section">
          <div style={{ textAlign: 'center', marginBottom: 48 }}>
            <h2 style={{ fontFamily: '"Crimson Pro", serif', fontSize: 'clamp(28px, 4vw, 44px)', fontWeight: 700 }}>
              Built for businesses where language is revenue.
            </h2>
          </div>
          <div className="vs-grid-2">
            {/* Export */}
            <div className="vs-card" style={{ borderLeft: `4px solid ${C.amber}` }}>
              <div style={{ fontSize: 36, marginBottom: 16 }}>🌏</div>
              <h3 style={{ fontFamily: '"Crimson Pro", serif', fontSize: 26, fontWeight: 700, marginBottom: 12, color: C.amber }}>Export Businesses</h3>
              <p style={{ color: C.muted, fontSize: 15, lineHeight: 1.7, marginBottom: 20 }}>
                Your buyers in Japan, the Middle East, Korea, and Europe want to do business with you —
                but language is the friction point. VaakSetu lets your sales team negotiate, follow up,
                and build relationships directly. No interpreter. No delays. No lost deals.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {['Negotiate directly with Japanese and Korean buyers','Build trust through direct conversation, not through a middleman','Follow up in their language — stand out from every other supplier','Languages: Japanese, Arabic, Korean, Mandarin, Spanish, German + more'].map(pt => (
                  <div key={pt} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <span style={{ color: C.amber, marginTop: 2, flexShrink: 0 }}>✓</span>
                    <span style={{ color: C.muted, fontSize: 14 }}>{pt}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Banking */}
            <div className="vs-card" style={{ borderLeft: `4px solid ${C.teal}` }}>
              <div style={{ fontSize: 36, marginBottom: 16 }}>🏦</div>
              <h3 style={{ fontFamily: '"Crimson Pro", serif', fontSize: 26, fontWeight: 700, marginBottom: 12, color: C.teal }}>Banks & Financial Services</h3>
              <p style={{ color: C.muted, fontSize: 15, lineHeight: 1.7, marginBottom: 20 }}>
                40% of India speaks no English. Your branch staff shouldn't have to guess what a customer needs.
                VaakSetu lets every agent serve every customer in their language —
                building the trust that keeps them loyal and reduces errors.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {['Serve rural and migrant customers in their native language','Reduce miscommunication errors in financial transactions','No training required — works on any existing phone','Languages: all 11 Indian languages including Hindi, Tamil, Bengali, Odia + more'].map(pt => (
                  <div key={pt} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <span style={{ color: C.teal, marginTop: 2, flexShrink: 0 }}>✓</span>
                    <span style={{ color: C.muted, fontSize: 14 }}>{pt}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Why VaakSetu ─────────────────────────────────────── */}
      <section className="vs-section">
        <div style={{ textAlign: 'center', marginBottom: 48 }}>
          <h2 style={{ fontFamily: '"Crimson Pro", serif', fontSize: 'clamp(28px, 4vw, 44px)', fontWeight: 700, marginBottom: 12 }}>
            Not a translation app.<br />A communication engine built for Indian business.
          </h2>
        </div>
        <div className="vs-grid-features">
          {[
            { icon: '⚡', title: 'Real-time, both directions', body: 'Not one-way subtitles. A live two-way conversation — both sides speak and hear naturally.' },
            { icon: '🇮🇳', title: 'Built for Indian languages', body: 'Sarvam AI powers our Indic models — outperforming Google Translate for Hindi, Tamil, Bengali, Gujarati, and more.' },
            { icon: '📱', title: 'Works on any device', body: 'No app install. Works on the phone your buyer already has. One link, that\'s it.' },
            { icon: '🔒', title: 'Private & secure', body: 'Conversations are not stored or shared. Your business discussions stay yours.' },
            { icon: '💸', title: 'No interpreter fees', body: 'One subscription replaces per-call interpreter costs. No booking in advance, no waiting.' },
            { icon: '🌐', title: '29 languages supported', body: '11 Indian languages + 18 international — covering every major trade partner and domestic region.' },
          ].map(({ icon, title, body }) => (
            <div key={title} className="vs-card" style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
              <div style={{ fontSize: 28, flexShrink: 0, lineHeight: 1 }}>{icon}</div>
              <div>
                <h3 style={{ fontFamily: '"Crimson Pro", serif', fontSize: 18, fontWeight: 600, marginBottom: 6 }}>{title}</h3>
                <p style={{ color: C.muted, fontSize: 14, lineHeight: 1.6 }}>{body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── CTA ──────────────────────────────────────────────── */}
      <section style={{ background: C.surface, borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ maxWidth: 700, margin: '0 auto', padding: '80px 24px', textAlign: 'center' }}>
          <div style={{ display: 'inline-block', background: 'rgba(15,184,169,0.12)', color: C.teal, padding: '6px 16px', borderRadius: 20, fontSize: 13, fontWeight: 500, marginBottom: 24, border: `1px solid rgba(15,184,169,0.2)` }}>
            Early Access
          </div>
          <h2 style={{ fontFamily: '"Crimson Pro", serif', fontSize: 'clamp(28px, 4vw, 44px)', fontWeight: 700, marginBottom: 16 }}>
            Ready to speak your customer's language?
          </h2>
          <p style={{ color: C.muted, fontSize: 17, lineHeight: 1.7, marginBottom: 12 }}>
            We're onboarding a small group of export businesses and banks for early access.
            Book a 20-minute demo and see it work live — in your language pair.
          </p>
          <p style={{ color: C.muted, fontSize: 15, lineHeight: 1.7, marginBottom: 36 }}>
            Early partners get free access and direct input into the product roadmap.
          </p>
          <div className="vs-hero-btns" style={{ display: 'flex', gap: 16, justifyContent: 'center', flexWrap: 'wrap' }}>
            <a className="vs-btn-primary" style={{ fontSize: 17, padding: '16px 40px' }} href={`mailto:${DEMO_EMAIL}?subject=Demo Request — VaakSetu`}>
              Book a Demo — It's Free
            </a>
            <button className="vs-btn-outline" style={{ fontSize: 17, padding: '16px 40px' }} onClick={() => navigate('/app')}>
              Try It Yourself →
            </button>
          </div>
          <p style={{ marginTop: 20, fontSize: 13, color: C.muted }}>No commitment. No credit card. Just a conversation.</p>
        </div>
      </section>

      {/* ── Footer ───────────────────────────────────────────── */}
      <footer style={{ maxWidth: 1080, margin: '0 auto', padding: '40px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 16 }}>
        <div>
          <span style={{ fontFamily: '"Crimson Pro", serif', fontSize: 18, fontWeight: 700, color: C.amber }}>VaakSetu</span>
          <p style={{ color: C.muted, fontSize: 13, marginTop: 4 }}>Multilingual Communication Engine</p>
          <p style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>Breaking language barriers for Indian businesses going global.</p>
        </div>
        <div style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
          <a href={`mailto:${DEMO_EMAIL}`} style={{ color: C.muted, fontSize: 14, textDecoration: 'none' }}>Contact</a>
          <button
            onClick={() => navigate('/app')}
            style={{ background: 'none', border: 'none', color: C.muted, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}
          >
            Try the App
          </button>
        </div>
      </footer>
    </div>
  );
}
