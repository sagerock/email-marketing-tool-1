import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Users,
  Mail,
  Zap,
  BarChart3,
  ArrowDown,
  Send,
  Shield,
  RefreshCw,
  TrendingUp,
} from 'lucide-react'
import Button from '../components/ui/Button'
import Input from '../components/ui/Input'

const features = [
  {
    name: 'Contact Management',
    description:
      'Organize, segment, and tag your contacts. Import from Salesforce or CSV with automatic deduplication.',
    icon: Users,
  },
  {
    name: 'Campaign Builder',
    description:
      'Design and send targeted email campaigns with merge tags, recipient filtering, and A/B testing.',
    icon: Mail,
  },
  {
    name: 'Automation Sequences',
    description:
      'Trigger multi-step email sequences from tags, Salesforce campaigns, or manual enrollment.',
    icon: Zap,
  },
  {
    name: 'Real Analytics',
    description:
      'Track opens, clicks, and conversions with bot-click filtering that shows real human engagement.',
    icon: BarChart3,
  },
]

const platformPoints = [
  {
    icon: RefreshCw,
    title: 'Salesforce Integration',
    description:
      'Two-way sync keeps your contacts, campaigns, and lead data connected without manual imports.',
  },
  {
    icon: Send,
    title: 'SendGrid Delivery',
    description:
      'Enterprise-grade email infrastructure with dedicated IP pools and high deliverability rates.',
  },
  {
    icon: Shield,
    title: 'Bot-Click Filtering',
    description:
      'Proprietary detection strips out security-scanner noise so your analytics reflect real engagement.',
  },
  {
    icon: TrendingUp,
    title: 'Built for Scale',
    description:
      'Multi-tenant architecture means each client gets isolated data, keys, and sending reputation.',
  },
]

export default function Landing() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')

  const handleContact = (e: React.FormEvent) => {
    e.preventDefault()
    const subject = encodeURIComponent(`SageRock Email Platform Inquiry from ${name}`)
    const body = encodeURIComponent(
      `Name: ${name}\nEmail: ${email}\n\nMessage:\n${message}`
    )
    window.location.href = `mailto:sage@sagerock.com?subject=${subject}&body=${body}`
  }

  const scrollToFeatures = () => {
    document.getElementById('features')?.scrollIntoView({ behavior: 'smooth' })
  }

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=DM+Serif+Display&display=swap');

        .landing-page { font-family: 'DM Sans', sans-serif; }
        .landing-page h1, .landing-page h2, .landing-page h3 { font-family: 'DM Serif Display', serif; }

        @keyframes drift {
          0%, 100% { transform: translate(0, 0) scale(1); opacity: 0.12; }
          25% { transform: translate(40px, -30px) scale(1.1); opacity: 0.18; }
          50% { transform: translate(-20px, 20px) scale(0.95); opacity: 0.10; }
          75% { transform: translate(30px, 40px) scale(1.05); opacity: 0.16; }
        }

        .hero-orb {
          position: absolute;
          border-radius: 50%;
          filter: blur(80px);
          animation: drift 20s ease-in-out infinite;
        }

        .feature-card {
          transition: transform 0.3s ease, box-shadow 0.3s ease;
        }
        .feature-card:hover {
          transform: translateY(-4px);
          box-shadow: 0 12px 32px rgba(0, 0, 0, 0.08);
        }

        .scroll-btn {
          animation: bounce-subtle 2.5s ease-in-out infinite;
        }
        @keyframes bounce-subtle {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(6px); }
        }
      `}</style>

      <div className="landing-page min-h-screen bg-white">
        {/* Header */}
        <header className="fixed top-0 left-0 right-0 z-50 bg-slate-900/80 backdrop-blur-md border-b border-white/5">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between h-16">
              <img
                src="/sagerock-logo.png"
                alt="SageRock"
                className="h-9 w-auto"
              />
              <Link to="/login">
                <Button
                  variant="ghost"
                  className="text-slate-300 hover:text-white hover:bg-white/10"
                >
                  Client Login
                </Button>
              </Link>
            </div>
          </div>
        </header>

        {/* Hero */}
        <section className="relative min-h-screen flex items-center justify-center overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
          {/* Animated orbs */}
          <div
            className="hero-orb bg-amber-500/30 w-96 h-96 top-1/4 left-1/4"
            style={{ animationDelay: '0s' }}
          />
          <div
            className="hero-orb bg-amber-400/20 w-72 h-72 bottom-1/4 right-1/4"
            style={{ animationDelay: '-7s' }}
          />
          <div
            className="hero-orb bg-slate-500/20 w-80 h-80 top-1/3 right-1/3"
            style={{ animationDelay: '-13s' }}
          />

          <div className="relative z-10 max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
            <h1 className="text-4xl sm:text-5xl lg:text-6xl text-white tracking-tight leading-tight">
              Email Marketing That{' '}
              <span className="text-amber-400">Delivers Results</span>
            </h1>
            <p className="mt-6 text-lg sm:text-xl text-slate-300 max-w-2xl mx-auto leading-relaxed">
              A purpose-built platform for companies that need reliable campaigns,
              smart automation, and analytics you can actually trust.
            </p>
            <button
              onClick={scrollToFeatures}
              className="scroll-btn mt-12 inline-flex items-center gap-2 text-amber-400 hover:text-amber-300 transition-colors text-sm font-medium tracking-wide uppercase"
            >
              Learn More
              <ArrowDown className="h-4 w-4" />
            </button>
          </div>
        </section>

        {/* Features */}
        <section id="features" className="py-24 bg-white">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="text-center mb-16">
              <h2 className="text-3xl sm:text-4xl text-slate-900">
                Everything You Need to Run Great Campaigns
              </h2>
              <p className="mt-4 text-lg text-slate-500 max-w-2xl mx-auto">
                Powerful tools without the bloat. Each feature is built around
                real workflows, not marketing checklists.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8">
              {features.map((feature) => {
                const Icon = feature.icon
                return (
                  <div
                    key={feature.name}
                    className="feature-card bg-white rounded-xl p-6 border border-slate-200"
                  >
                    <div className="w-12 h-12 bg-amber-50 rounded-lg flex items-center justify-center mb-4">
                      <Icon className="h-6 w-6 text-amber-500" />
                    </div>
                    <h3 className="text-lg text-slate-900 mb-2">{feature.name}</h3>
                    <p className="text-slate-500 text-sm leading-relaxed">
                      {feature.description}
                    </p>
                  </div>
                )
              })}
            </div>
          </div>
        </section>

        {/* Platform */}
        <section className="py-24 bg-slate-50">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="text-center mb-16">
              <h2 className="text-3xl sm:text-4xl text-slate-900">
                What Sets This Platform Apart
              </h2>
              <p className="mt-4 text-lg text-slate-500 max-w-2xl mx-auto">
                Built on enterprise-grade infrastructure with integrations that
                keep your data connected and your metrics honest.
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl mx-auto">
              {platformPoints.map((point) => {
                const Icon = point.icon
                return (
                  <div key={point.title} className="flex gap-4">
                    <div className="w-11 h-11 bg-amber-500 rounded-lg flex items-center justify-center flex-shrink-0">
                      <Icon className="h-5 w-5 text-white" />
                    </div>
                    <div>
                      <h3 className="text-lg text-slate-900 mb-1">{point.title}</h3>
                      <p className="text-slate-500 text-sm leading-relaxed">
                        {point.description}
                      </p>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </section>

        {/* Contact */}
        <section className="py-24 bg-white">
          <div className="max-w-xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="text-center mb-10">
              <h2 className="text-3xl sm:text-4xl text-slate-900">Interested?</h2>
              <p className="mt-4 text-lg text-slate-500">
                Tell us about your email marketing needs and we'll be in touch.
              </p>
            </div>
            <form onSubmit={handleContact} className="space-y-5">
              <Input
                label="Name"
                placeholder="Your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
              <Input
                label="Email"
                type="email"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              <div className="w-full">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Message
                </label>
                <textarea
                  placeholder="Tell us about your needs..."
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={4}
                  required
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <Button type="submit" size="lg" className="w-full bg-amber-500 hover:bg-amber-600 text-white focus-visible:ring-amber-500">
                Send Message
              </Button>
            </form>
          </div>
        </section>

        {/* Footer */}
        <footer className="py-10 bg-slate-900 border-t border-slate-800">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
              <img
                src="/sagerock-logo.png"
                alt="SageRock"
                className="h-7 w-auto"
              />
              <p className="text-slate-500 text-sm">
                © {new Date().getFullYear()} SageRock. All rights reserved.
              </p>
              <a
                href="https://sagerock.com"
                className="text-slate-500 hover:text-slate-300 text-sm transition-colors"
              >
                sagerock.com
              </a>
            </div>
          </div>
        </footer>
      </div>
    </>
  )
}
