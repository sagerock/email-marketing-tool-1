import { Link } from 'react-router-dom'
import {
  Mail,
  Users,
  Zap,
  BarChart3,
  Database,
  Cloud,
  Server,
  CheckCircle,
  ArrowRight
} from 'lucide-react'
import Button from '../components/ui/Button'

const features = [
  {
    name: 'Contact Management',
    description: 'Import, organize, and segment your contacts with powerful tagging and filtering.',
    icon: Users,
  },
  {
    name: 'Email Campaigns',
    description: 'Create and send beautiful email campaigns with our intuitive design tools.',
    icon: Mail,
  },
  {
    name: 'Automation Sequences',
    description: 'Set up automated email sequences that nurture leads while you sleep.',
    icon: Zap,
  },
  {
    name: 'Real-time Analytics',
    description: 'Track opens, clicks, and conversions with detailed campaign analytics.',
    icon: BarChart3,
  },
]

const techStack = [
  {
    name: 'Supabase',
    description: 'Your contacts and data stored securely in a modern, scalable database.',
    icon: Database,
  },
  {
    name: 'SendGrid',
    description: 'Industry-leading email delivery with high deliverability rates.',
    icon: Server,
  },
  {
    name: 'Amazon S3',
    description: 'Email assets and images hosted on reliable cloud storage.',
    icon: Cloud,
  },
]

const benefits = [
  'Pay only for what you use',
  'No bloated features you don\'t need',
  'Best-in-class services at each layer',
  'Low overhead, high performance',
  'Simple, transparent pricing',
  'Enterprise-grade infrastructure',
]

export default function Landing() {
  return (
    <div className="min-h-screen bg-white">
      {/* Header */}
      <header className="fixed top-0 left-0 right-0 bg-white/95 backdrop-blur-sm border-b border-gray-200 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <img
              src="https://sagerock.com/wp-content/uploads/2024/05/sagerocklogo2024-300x70.png"
              alt="SageRock"
              className="h-10 w-auto"
            />
            <div className="flex items-center gap-4">
              <Link to="/login">
                <Button variant="ghost">Sign In</Button>
              </Link>
              <Link to="/signup">
                <Button>Get Started</Button>
              </Link>
            </div>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="pt-32 pb-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto text-center">
          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-gray-900 tracking-tight">
            Email Marketing,{' '}
            <span className="text-blue-600">Simplified</span>
          </h1>
          <p className="mt-6 text-xl text-gray-600 max-w-3xl mx-auto">
            The SageRock email marketing platform where you only pay for the tools you need,
            not extra stuff you don't use.
          </p>
          <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link to="/signup">
              <Button size="lg" className="px-8">
                Start Free Trial
                <ArrowRight className="ml-2 h-5 w-5" />
              </Button>
            </Link>
            <Link to="/login">
              <Button variant="outline" size="lg" className="px-8">
                Sign In to Your Account
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="py-20 bg-gray-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold text-gray-900">
              Everything You Need, Nothing You Don't
            </h2>
            <p className="mt-4 text-lg text-gray-600">
              Powerful features designed for results, not complexity.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
            {features.map((feature) => {
              const Icon = feature.icon
              return (
                <div
                  key={feature.name}
                  className="bg-white rounded-xl p-6 shadow-sm border border-gray-200 hover:shadow-md transition-shadow"
                >
                  <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center mb-4">
                    <Icon className="h-6 w-6 text-blue-600" />
                  </div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-2">
                    {feature.name}
                  </h3>
                  <p className="text-gray-600">
                    {feature.description}
                  </p>
                </div>
              )
            })}
          </div>
        </div>
      </section>

      {/* Benefits Section */}
      <section className="py-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
            <div>
              <h2 className="text-3xl font-bold text-gray-900 mb-6">
                Why Pay for Features You'll Never Use?
              </h2>
              <p className="text-lg text-gray-600 mb-8">
                Most email marketing platforms charge you for a mountain of features
                you'll never touch. We believe in a different approach: give you exactly
                what you need to run successful email campaigns, powered by the best
                services in the industry.
              </p>
              <ul className="space-y-4">
                {benefits.map((benefit) => (
                  <li key={benefit} className="flex items-center gap-3">
                    <CheckCircle className="h-5 w-5 text-green-500 flex-shrink-0" />
                    <span className="text-gray-700">{benefit}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="bg-gradient-to-br from-blue-600 to-blue-800 rounded-2xl p-8 text-white">
              <h3 className="text-2xl font-bold mb-6">Built on Best-in-Class Services</h3>
              <div className="space-y-6">
                {techStack.map((tech) => {
                  const Icon = tech.icon
                  return (
                    <div key={tech.name} className="flex gap-4">
                      <div className="w-10 h-10 bg-white/20 rounded-lg flex items-center justify-center flex-shrink-0">
                        <Icon className="h-5 w-5 text-white" />
                      </div>
                      <div>
                        <h4 className="font-semibold">{tech.name}</h4>
                        <p className="text-blue-100 text-sm">{tech.description}</p>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-20 bg-gray-900">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-3xl font-bold text-white mb-4">
            Ready to Simplify Your Email Marketing?
          </h2>
          <p className="text-xl text-gray-400 mb-8 max-w-2xl mx-auto">
            Join businesses that are saving money and getting better results
            with a streamlined email marketing approach.
          </p>
          <Link to="/signup">
            <Button size="lg" className="px-8 bg-white text-gray-900 hover:bg-gray-100">
              Get Started Today
              <ArrowRight className="ml-2 h-5 w-5" />
            </Button>
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-12 bg-gray-50 border-t border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4">
            <img
              src="https://sagerock.com/wp-content/uploads/2024/05/sagerocklogo2024-300x70.png"
              alt="SageRock"
              className="h-8 w-auto"
            />
            <p className="text-gray-500 text-sm">
              © {new Date().getFullYear()} SageRock. All rights reserved.
            </p>
            <div className="flex items-center gap-6">
              <a href="https://sagerock.com" className="text-gray-500 hover:text-gray-700 text-sm">
                SageRock.com
              </a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  )
}
