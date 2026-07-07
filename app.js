require('dotenv').config();

const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const STATE_FILE = process.env.STATE_FILE_PATH || '/data/appointment-state.json';
const APP_URL = 'https://appointment.cgifrankfurt.gov.in/application';

const JURISDICTION = process.env.JURISDICTION;
const SERVICE_CATEGORY = process.env.SERVICE_CATEGORY || 'OCI Services';
const SERVICE_TYPE = process.env.SERVICE_TYPE;
const APPLICATION_REFERENCE_NO = process.env.APPLICATION_REFERENCE_NO;
const MAX_MONTHS_TO_CHECK = parseInt(process.env.MAX_MONTHS_TO_CHECK || '3', 10);
const MAX_RESULTS_TO_FIND = parseInt(process.env.MAX_RESULTS_TO_FIND || '3', 10);
// 'always' notifies on every run that finds slots; 'when_changed' (default) only
// notifies when the earliest slot is new or earlier than the last one notified
const NOTIFICATION_MODE = process.env.NOTIFICATION_MODE === 'always' ? 'always' : 'when_changed';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

const REQUIRED_ENV_VARS = { JURISDICTION, SERVICE_TYPE, APPLICATION_REFERENCE_NO };
const missingEnvVars = Object.entries(REQUIRED_ENV_VARS)
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (missingEnvVars.length > 0) {
  console.error(`❌ Missing required env var(s): ${missingEnvVars.join(', ')}`);
  process.exit(1);
}

// Ensure the state file's directory exists
const stateDir = path.dirname(STATE_FILE);
if (!fs.existsSync(stateDir)) {
  fs.mkdirSync(stateDir, { recursive: true });
}

// Load previous state
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.log('No previous state found, starting fresh');
  }
  return { earliestDateTime: null, lastCheck: new Date().toISOString() };
}

// Save state
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// Select a <select> option by its visible label rather than its value attribute
// (the site's option values are opaque numeric codes, not the display text)
async function selectByVisibleText(page, selector, text) {
  const value = await page.$eval(selector, (el, text) => {
    const opt = Array.from(el.options).find(o => o.text.trim() === text);
    return opt ? opt.value : null;
  }, text);
  if (value === null) {
    throw new Error(`Option "${text}" not found in ${selector}`);
  }
  await page.select(selector, value);
}

// Step 1: accept the general instructions
async function acceptGeneralInstructions(page) {
  console.log('📄 Accepting general instructions...');
  await page.goto(APP_URL, { waitUntil: 'networkidle2' });
  await page.waitForSelector('input[type="checkbox"]', { timeout: 10000 });
  await page.click('input[type="checkbox"]');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }),
    page.click('#btnSubmit')
  ]);
}

// Step 2: pick the jurisdiction
async function selectJurisdiction(page) {
  console.log(`🗺️  Selecting jurisdiction: ${JURISDICTION}...`);
  await page.waitForSelector('#dropdown', { timeout: 10000 });
  await selectByVisibleText(page, '#dropdown', JURISDICTION);
  await page.click('input[type="checkbox"]');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }),
    page.click('#btnSubmit')
  ]);
}

// Step 3: fill in the application form up to the appointment date field
async function fillApplicationForm(page) {
  console.log(`📝 Filling application form (${SERVICE_CATEGORY} → ${SERVICE_TYPE})...`);
  await page.waitForSelector('#apt_group', { timeout: 10000 });
  await page.click('#apt_group'); // "Individual"

  await selectByVisibleText(page, '#category', SERVICE_CATEGORY);
  await page.waitForFunction(() => {
    const sel = document.querySelector('#service');
    return sel && sel.options.length > 1;
  }, { timeout: 10000 });
  await selectByVisibleText(page, '#service', SERVICE_TYPE);

  await page.type('#app_ref_no', APPLICATION_REFERENCE_NO);
}

// Read the currently displayed month/year and its bookable days
async function readCalendarMonth(page) {
  return page.evaluate(() => {
    const month = parseInt(document.querySelector('.ui-datepicker-month').value, 10);
    const year = parseInt(document.querySelector('.ui-datepicker-year').value, 10);
    const days = Array.from(document.querySelectorAll('td[data-handler="selectDay"]'))
      .map(td => parseInt(td.querySelector('a').textContent, 10))
      .sort((a, b) => a - b);
    return { month, year, days };
  });
}

// Format a slot id like "1220-1230" as "12:20–12:30"
function formatTimeRange(rangeId) {
  const fmt = t => `${t.slice(0, 2)}:${t.slice(2, 4)}`;
  const [start, end] = rangeId.split('-');
  return `${fmt(start)}–${fmt(end)}`;
}

// Click a specific day cell in the currently displayed calendar month,
// re-querying fresh each time since jQuery UI redraws the table on selection
async function clickDayByNumber(page, day) {
  const handle = await page.evaluateHandle((day) => {
    const links = Array.from(document.querySelectorAll('td[data-handler="selectDay"] a'));
    return links.find(a => a.textContent.trim() === String(day));
  }, day);
  const element = handle.asElement();
  if (!element) {
    throw new Error(`Day ${day} is no longer clickable in the calendar`);
  }
  await element.click();
  await element.dispose();
}

// The site auto-closes the calendar popup once a date is picked (to reveal the
// time-slot list), so it must be reopened before every subsequent interaction
async function ensureCalendarOpen(page) {
  await page.click('#appmnt_date');
  await page.waitForSelector('.ui-datepicker-calendar', { visible: true, timeout: 10000 });
}

// Select a date on the calendar and return its open time slots (earliest first)
async function getOpenTimeSlotsForDay(page, day, month, year) {
  await ensureCalendarOpen(page);
  await clickDayByNumber(page, day);

  const expectedDateStr = `${String(day).padStart(2, '0')}-${String(month + 1).padStart(2, '0')}-${year}`;
  await page.waitForFunction(
    (expected) => document.querySelector('#appmnt_date').value === expected,
    { timeout: 10000 },
    expectedDateStr
  );
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 10000 }).catch(() => {});
  await page.waitForFunction(
    () => document.querySelectorAll('#timeslots input.appmnt_time').length > 0,
    { timeout: 10000 }
  );

  const openSlots = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('#timeslots input.appmnt_time:not([disabled])'))
      .map(input => input.id);
  });
  return openSlots.sort();
}

// Open the calendar and scan forward, date by date, collecting the earliest
// open time slot for each of up to MAX_RESULTS_TO_FIND distinct bookable dates
async function findAvailableSlots(page) {
  console.log('📅 Opening appointment calendar...');
  await ensureCalendarOpen(page);

  const results = [];

  for (let i = 0; i < MAX_MONTHS_TO_CHECK && results.length < MAX_RESULTS_TO_FIND; i++) {
    const { month, year, days } = await readCalendarMonth(page);
    console.log(`   ${MONTH_NAMES[month]} ${year}: ${days.length} bookable day(s) on the calendar`);

    for (const day of days) {
      if (results.length >= MAX_RESULTS_TO_FIND) break;

      const openSlots = await getOpenTimeSlotsForDay(page, day, month, year);
      console.log(`     ${MONTH_NAMES[month]} ${day}, ${year}: ${openSlots.length} open time slot(s)`);

      if (openSlots.length > 0) {
        results.push({
          date: `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
          month, year, day,
          time: openSlots[0]
        });
      }
    }

    if (results.length >= MAX_RESULTS_TO_FIND) break;

    await ensureCalendarOpen(page);
    const nextButton = await page.$('.ui-datepicker-next');
    if (!nextButton) break;
    await nextButton.click();
    await page.waitForFunction(
      (prevMonth) => document.querySelector('.ui-datepicker-month').value != prevMonth,
      { timeout: 10000 },
      month
    );
  }

  return results;
}

// Escape text for Telegram's HTML parse mode
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Send Telegram notification
async function sendTelegramNotification(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('No Telegram credentials configured, skipping notification');
    return;
  }

  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message.text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(message.button && {
        reply_markup: {
          inline_keyboard: [[{ text: message.button.text, url: message.button.url }]]
        }
      })
    });
    console.log('✅ Telegram notification sent');
  } catch (err) {
    console.error('❌ Failed to send Telegram notification:', err.response?.data || err.message);
  }
}

// Main function
async function checkAppointments() {
  let browser;

  try {
    console.log('🔍 Starting appointment check...');
    console.log(`⏰ Check time: ${new Date().toISOString()}`);

    // Load previous state
    const state = loadState();
    console.log(`📌 Previous earliest: ${state.earliestDateTime || 'None'}`);

    // Launch browser
    browser = await puppeteer.launch({
      headless: 'new',
      defaultViewport: { width: 1280, height: 1000 },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(30000);

    // Walk through the booking wizard up to the calendar
    await acceptGeneralInstructions(page);
    await selectJurisdiction(page);
    await fillApplicationForm(page);
    const slots = await findAvailableSlots(page);

    if (slots.length > 0) {
      const earliest = slots[0];
      const earliestDateTime = `${earliest.date} ${earliest.time}`;
      const isNewOrEarlier = !state.earliestDateTime || earliestDateTime < state.earliestDateTime;
      const shouldNotify = NOTIFICATION_MODE === 'always' || isNewOrEarlier;

      console.log(`\n✅ FOUND ${slots.length} AVAILABLE SLOT(S):`);
      slots.forEach((s, i) => {
        console.log(`   ${i + 1}. ${MONTH_NAMES[s.month]} ${s.day}, ${s.year} — ${formatTimeRange(s.time)}`);
      });

      if (isNewOrEarlier) {
        console.log(`\n🎉 NEW/EARLIER SLOT FOUND!`);
      } else {
        console.log(`No change from previous earliest: ${state.earliestDateTime}`);
      }

      if (shouldNotify) {
        const slotLines = slots
          .map((s, i) => `${i + 1}. <b>${MONTH_NAMES[s.month]} ${s.day}, ${s.year}</b> — ${formatTimeRange(s.time)}`)
          .join('\n');
        const title = isNewOrEarlier
          ? '🎉 <b>New OCI Appointment Slot(s) Found!</b>'
          : '📋 <b>OCI Appointment Slot(s) Still Available</b>';

        await sendTelegramNotification({
          text: `${title}\n\n${slotLines}\n\n<i>Last checked: ${new Date().toISOString()}</i>`,
          button: { text: 'Book Appointment', url: APP_URL }
        });
      }

      if (isNewOrEarlier) {
        state.earliestDateTime = earliestDateTime;
        state.lastCheck = new Date().toISOString();
        saveState(state);
      }
    } else {
      console.log(`❌ No available slots found in the next ${MAX_MONTHS_TO_CHECK} month(s)`);
    }

    await browser.close();
    console.log('\n✅ Check completed successfully\n');

  } catch (error) {
    console.error('❌ Error during appointment check:', error);

    // Send error notification to Telegram
    await sendTelegramNotification({
      text: `⚠️ <b>Error in appointment monitor</b>\n<pre>${escapeHtml(error.message)}</pre>`
    });

    process.exit(1);
  }
}

// Run the check
checkAppointments();
