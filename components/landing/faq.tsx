import { Minus, Plus } from 'lucide-react';
import { LandingHeading, LandingSection } from './ui';

const questions = [
  ['What is Revline, and who is it for?', 'Revline is an AI video editor you talk to. Upload raw footage, describe what you want, and the agent cuts, captions and formats it for you. It’s built for creators, podcasters, marketers and teams who publish video but don’t want to live in a timeline.'],
  ['What kinds of videos can I make?', 'Podcast clips, vlogs, product demos, tutorials, ads, talking-head videos and social shorts. If you filmed it, Revline can help you edit it.'],
  ['How is Revline different from a regular video editor?', 'You describe the edit instead of building it by hand. Revline makes the cuts, captions and framing for you, then you review the result and refine it in conversation.'],
  ['Can I still edit the timeline myself?', 'Yes. Every change the agent makes lands on a real timeline. Trim, move, duplicate or delete clips yourself, and undo anything.'],
  ['What file formats and lengths are supported?', 'Upload common video, audio and image files, or import a YouTube link. Long recordings are fine.'],
  ['Will my videos use my brand fonts and colors?', 'Ask for them in the conversation. Revline can style captions and titles with its built-in fonts and the colors you choose.'],
  ['Is my footage private?', 'Your projects belong to your account and require sign-in. Your footage is used to prepare your edits and exports.'],
  ['How much does Revline cost? Is there a free plan?', 'Revline MCP is $19 USD per month: edit from Claude, ChatGPT, Codex or Cursor, with the web editor for manual edits. Revline Pro is $39 USD per month and adds editing by prompting inside Revline. Both start with a 3-day free trial. Cancel before the trial ends if you don’t want to continue.'],
];

export function LandingFaq() {
  return <LandingSection id="faq" className="landing-faq" headingId="landing-faq-heading" data-nav-tone="dark">
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: questions.map(([name, text]) => ({
        '@type': 'Question', name, acceptedAnswer: { '@type': 'Answer', text },
      })),
    }).replace(/</g, '\\u003c') }} />
    <LandingHeading id="landing-faq-heading" title="Frequently asked questions" />
    <div className="landing-faq-list">{questions.map(([question, answer], index) => <details name="landing-faq" key={question} open={index === 0}>
      <summary>{question}<Plus className="landing-faq-plus" size={18} aria-hidden="true" /><Minus className="landing-faq-minus" size={18} aria-hidden="true" /></summary>
      <p>{answer}</p>
    </details>)}</div>
  </LandingSection>;
}
