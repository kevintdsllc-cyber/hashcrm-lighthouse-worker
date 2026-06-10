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

  const result = {
    leadId: job.lead_id,
    url,
    pagespeed,
    summary: {
      mobilePerformance: pagespeed.mobile?.scores?.performance ?? null,
      desktopPerformance: pagespeed.desktop?.scores?.performance ?? null,
      mobileSeo: pagespeed.mobile?.scores?.seo ?? null,
      desktopSeo: pagespeed.desktop?.scores?.seo ?? null,
      mobileAccessibility: pagespeed.mobile?.scores?.accessibility ?? null,
      desktopAccessibility: pagespeed.desktop?.scores?.accessibility ?? null,
      mobileBestPractices: pagespeed.mobile?.scores?.bestPractices ?? null,
      desktopBestPractices: pagespeed.desktop?.scores?.bestPractices ?? null
    }
  };

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
