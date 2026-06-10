import { createClient } from '@supabase/supabase-js';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  JOB_ID
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !JOB_ID) {
  throw new Error('Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or JOB_ID');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

function normalizeUrl(input) {
  let url = String(input || '').trim();

  if (!url) {
    throw new Error('Missing URL');
  }

  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }

  const parsed = new URL(url);

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only HTTP/HTTPS URLs are allowed');
  }

  return parsed.toString();
}

async function updateJob(patch) {
  const { error } = await supabase
    .from('lighthouse_jobs')
    .update({
      ...patch,
      updated_at: new Date().toISOString()
    })
    .eq('id', JOB_ID);

  if (error) {
    console.error(error);
    throw error;
  }
}

function score(lhr, category) {
  const value = lhr.categories?.[category]?.score;
  return typeof value === 'number' ? Math.round(value * 100) : null;
}

function metric(lhr, id) {
  const audit = lhr.audits?.[id];

  return {
    id,
    title: audit?.title || id,
    displayValue: audit?.displayValue || '',
    numericValue: typeof audit?.numericValue === 'number' ? audit.numericValue : null,
    score: typeof audit?.score === 'number' ? audit.score : null
  };
}

function opportunities(lhr) {
  return Object.values(lhr.audits || {})
    .filter((audit) => {
      return (
        audit.details?.type === 'opportunity' ||
        (
          typeof audit.numericValue === 'number' &&
          audit.numericValue > 0 &&
          audit.score !== null &&
          audit.score < 1
        )
      );
    })
    .map((audit) => ({
      id: audit.id,
      title: audit.title,
      description: audit.description,
      displayValue: audit.displayValue || '',
      score: audit.score,
      numericValue: audit.numericValue || 0,
      savingsMs: audit.details?.overallSavingsMs || audit.numericValue || 0
    }))
    .sort((a, b) => (b.savingsMs || 0) - (a.savingsMs || 0))
    .slice(0, 20);
}

function diagnostics(lhr) {
  const ids = [
    'render-blocking-resources',
    'unused-css-rules',
    'unused-javascript',
    'modern-image-formats',
    'uses-optimized-images',
    'uses-text-compression',
    'server-response-time',
    'dom-size',
    'third-party-summary',
    'bootup-time',
    'mainthread-work-breakdown',
    'duplicated-javascript',
    'legacy-javascript'
  ];

  return ids
    .map((id) => lhr.audits?.[id])
    .filter(Boolean)
    .map((audit) => ({
      id: audit.id,
      title: audit.title,
      description: audit.description,
      displayValue: audit.displayValue || '',
      score: audit.score,
      numericValue: typeof audit.numericValue === 'number' ? audit.numericValue : null
    }));
}

function summarize(lhr, strategy) {
  return {
    strategy,
    requestedUrl: lhr.requestedUrl,
    finalUrl: lhr.finalUrl,
    fetchTime: lhr.fetchTime,
    lighthouseVersion: lhr.lighthouseVersion,
    scores: {
      performance: score(lhr, 'performance'),
      accessibility: score(lhr, 'accessibility'),
      bestPractices: score(lhr, 'best-practices'),
      seo: score(lhr, 'seo')
    },
    metrics: {
      firstContentfulPaint: metric(lhr, 'first-contentful-paint'),
      largestContentfulPaint: metric(lhr, 'largest-contentful-paint'),
      speedIndex: metric(lhr, 'speed-index'),
      totalBlockingTime: metric(lhr, 'total-blocking-time'),
      cumulativeLayoutShift: metric(lhr, 'cumulative-layout-shift'),
      interactive: metric(lhr, 'interactive')
    },
    opportunities: opportunities(lhr),
    diagnostics: diagnostics(lhr)
  };
}

async function runLighthouse(url, strategy, categories) {
  const chrome = await chromeLauncher.launch({
    chromeFlags: [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-background-networking'
    ]
  });

  try {
    const flags = {
      port: chrome.port,
      output: 'json',
      logLevel: 'info',
      onlyCategories: categories
    };

    if (strategy === 'desktop') {
      flags.preset = 'desktop';
    } else {
      flags.formFactor = 'mobile';
      flags.screenEmulation = {
        mobile: true,
        width: 412,
        height: 823,
        deviceScaleFactor: 1.75,
        disabled: false
      };
    }

    const result = await lighthouse(url, flags);
    return summarize(result.lhr, strategy);
  } finally {
    await chrome.kill();
  }
}
function toCrmPagespeedDevice(result) {
  const issues = [
    ...(result.opportunities || []).map((item) => item.title),
    ...(result.diagnostics || [])
      .filter((item) => item.score !== 1)
      .map((item) => item.title)
  ]
    .filter(Boolean)
    .slice(0, 8);

  const suggestedImprovements = [];

  if ((result.scores?.performance ?? 100) < 50) {
    suggestedImprovements.push('Strong speed optimization opportunity');
  }

  if ((result.scores?.seo ?? 100) < 70) {
    suggestedImprovements.push('SEO/website structure opportunity');
  }

  if ((result.scores?.accessibility ?? 100) < 70) {
    suggestedImprovements.push('Accessibility and usability improvement opportunity');
  }

  if ((result.scores?.bestPractices ?? 100) < 70) {
    suggestedImprovements.push('Technical cleanup opportunity');
  }

  if (!suggestedImprovements.length && issues.length) {
    suggestedImprovements.push('Review the listed Lighthouse issues and optimize the highest-impact items first.');
  }

  return {
    strategy: result.strategy,
    performance: result.scores?.performance ?? null,
    accessibility: result.scores?.accessibility ?? null,
    bestPractices: result.scores?.bestPractices ?? null,
    seo: result.scores?.seo ?? null,
    firstContentfulPaint: result.metrics?.firstContentfulPaint?.displayValue || '',
    largestContentfulPaint: result.metrics?.largestContentfulPaint?.displayValue || '',
    speedIndex: result.metrics?.speedIndex?.displayValue || '',
    totalBlockingTime: result.metrics?.totalBlockingTime?.displayValue || '',
    cumulativeLayoutShift: result.metrics?.cumulativeLayoutShift?.displayValue || '',
    mainIssues: issues,
    suggestedImprovements,
    finalUrl: result.finalUrl,
    lighthouseVersion: result.lighthouseVersion,
    fetchTime: result.fetchTime
  };
}
async function main() {
  const { data: job, error } = await supabase
    .from('lighthouse_jobs')
    .select('*')
    .eq('id', JOB_ID)
    .single();

  if (error || !job) {
    throw new Error(`Job not found: ${JOB_ID}`);
  }

  const url = normalizeUrl(job.url);

  const strategies =
    Array.isArray(job.strategies) && job.strategies.length
      ? job.strategies
      : ['mobile', 'desktop'];

  const categories =
    Array.isArray(job.categories) && job.categories.length
      ? job.categories
      : ['performance', 'accessibility', 'best-practices', 'seo'];

  await updateJob({
    status: 'running',
    progress: 5,
    current_step: `Starting Lighthouse audit for ${url}`,
    error: null
  });

  const pagespeed = {};

  for (let i = 0; i < strategies.length; i++) {
    const strategy = strategies[i];

    await updateJob({
      progress: Math.round((i / strategies.length) * 90) + 5,
      current_step: `Running ${strategy} Lighthouse audit`
    });

    pagespeed[strategy] = await runLighthouse(url, strategy, categories);
  }

  const crmPagespeed = {};

for (const [strategy, strategyResult] of Object.entries(pagespeed)) {
  crmPagespeed[strategy] = toCrmPagespeedDevice(strategyResult);
}

crmPagespeed.auditedAt = new Date().toISOString();

const result = {
  type: job.job_type || 'pagespeed-audit',
  leadId: job.lead_id,
  url,
  pagespeed: crmPagespeed,
  rawPagespeed: pagespeed,
  leadResults: [
    {
      leadId: job.lead_id,
      ok: true,
      pagespeed: crmPagespeed
    }
  ],
  summary: {
    mobilePerformance: crmPagespeed.mobile?.performance ?? null,
    desktopPerformance: crmPagespeed.desktop?.performance ?? null,
    mobileSeo: crmPagespeed.mobile?.seo ?? null,
    desktopSeo: crmPagespeed.desktop?.seo ?? null,
    mobileAccessibility: crmPagespeed.mobile?.accessibility ?? null,
    desktopAccessibility: crmPagespeed.desktop?.accessibility ?? null,
    mobileBestPractices: crmPagespeed.mobile?.bestPractices ?? null,
    desktopBestPractices: crmPagespeed.desktop?.bestPractices ?? null
  }
};

if (job.lead_id) {
  const { error: leadUpdateError } = await supabase
    .from('leads')
    .update({
      pagespeed: crmPagespeed,
      status: 'Speed Audited',
      updated_at: new Date().toISOString()
    })
    .eq('id', job.lead_id);

  if (leadUpdateError) {
    console.warn('Lead pagespeed update failed:', leadUpdateError.message);
  }
}

  await updateJob({
    status: 'completed',
    progress: 100,
    current_step: 'Completed',
    result,
    completed_at: new Date().toISOString()
  });

  console.log('Completed job:', JOB_ID);
}

main().catch(async (error) => {
  console.error(error);

  await updateJob({
    status: 'failed',
    progress: 100,
    current_step: 'Failed',
    error: error?.message || String(error),
    completed_at: new Date().toISOString()
  });

  process.exit(1);
});
