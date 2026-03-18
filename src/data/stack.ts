export type ArsenalCategory = {
  icon: string;
  label: string;
  subtitle?: string;
  items: string[];
  highlight?: boolean;
  variant?: 'default' | 'purple';
};

export const arsenal: {
  pt: { title: string; categories: ArsenalCategory[] };
  en: { title: string; categories: ArsenalCategory[] };
} = {
  pt: {
    title: 'Arsenal Técnico',
    categories: [
      {
        icon: '🏆',
        label: '7+ anos de experiência',
        subtitle: 'Tech Lead e Arquiteto Cloud',
        highlight: true,
        items: [],
      },
      {
        icon: '☁️',
        label: 'Infraestrutura Cloud',
        items: ['Azure', 'AWS', 'GCP', 'Ansible', 'Terraform', 'Kubernetes'],
      },
      {
        icon: '⚙️',
        label: 'DevOps',
        variant: 'purple',
        items: ['Agile', 'SCRUM', 'GitHub Actions', 'Azure DevOps', 'Bash Scripting', 'Python', 'CI/CD'],
      },
    ],
  },
  en: {
    title: 'Technical Arsenal',
    categories: [
      {
        icon: '🏆',
        label: '7+ years experience',
        subtitle: 'Team Lead and Cloud Architect',
        highlight: true,
        items: [],
      },
      {
        icon: '☁️',
        label: 'Cloud Infrastructure',
        items: ['Azure', 'AWS', 'GCP', 'Ansible', 'Terraform', 'Kubernetes'],
      },
      {
        icon: '⚙️',
        label: 'DevOps',
        variant: 'purple',
        items: ['Agile', 'SCRUM', 'GitHub Actions', 'Azure DevOps', 'Bash Scripting', 'Python', 'CI/CD'],
      },
    ],
  },
};