'use client';

import { ChevronDown } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

// What the product does beyond the basics, in page order.
const sections = [
  { label: 'Clipping', note: 'Turn streams into vertical clips', href: '/#clippers' },
  { label: 'Motion design', note: 'Launch films and motion graphics', href: '/#motion-design' },
  { label: 'Features', note: 'Effects done by asking', href: '/#features' },
  { label: 'Genesis', note: 'Select and layer anything, via MCP', href: '/#genesis' },
];

export function LandingProductMenu() {
  return <DropdownMenu modal={false}>
    <DropdownMenuTrigger className="landing-nav-menu">Product<ChevronDown size={14} aria-hidden="true" /></DropdownMenuTrigger>
    <DropdownMenuContent align="center" sideOffset={10} className="landing-product-menu w-72 p-1.5">
      {sections.map(section => <DropdownMenuItem key={section.href} asChild className="flex-col items-start gap-0.5 px-3 py-2">
        <a href={section.href}>
          <span className="landing-product-menu-label">{section.label}</span>
          <span className="landing-product-menu-note">{section.note}</span>
        </a>
      </DropdownMenuItem>)}
    </DropdownMenuContent>
  </DropdownMenu>;
}
