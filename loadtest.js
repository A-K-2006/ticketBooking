import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import exec from 'k6/execution';

// Usage:
//   k6 run loadtest.js
//   k6 run -e MODE=optimistic loadtest.js
//   k6 run -e BASE_URL=http://localhost:8080 -e EVENT_ID=1 loadtest.js

const BASE = __ENV.BASE_URL || 'http://localhost:8080';
const EVENT_ID = Number(__ENV.EVENT_ID || 1);
const MODE = __ENV.MODE || 'pessimistic'; // or 'optimistic'
const N_USERS = 100;
const N_SEATS = 300;
const RUN = Date.now();

const bookingOk = new Counter('bookings_success');
const bookingRejected = new Counter('bookings_rejected_4xx'); // 409 etc, expected under contention
const bookingRateLimited = new Counter('bookings_rate_limited_429');
const bookingServerError = new Counter('bookings_server_error_5xx');

const JSON_H = { 'Content-Type': 'application/json' };

export const options = {
  scenarios: {
    // 1. Read-heavy: exercises the Redis seat cache
    read_seats: {
      executor: 'constant-arrival-rate',
      rate: 200,
      timeUnit: '1s',
      duration: '1m',
      preAllocatedVUs: 50,
      maxVUs: 200,
      exec: 'readSeats',
    },
    // 2. Contention: 100 users fight for the SAME seat. Expect exactly 1 success.
    contention: {
      executor: 'per-vu-iterations',
      vus: N_USERS,
      iterations: 1,
      startTime: '1m10s',
      exec: 'contendForOneSeat',
    },
    // 3. Spread: many users book DIFFERENT seats. Measures throughput.
    spread: {
      executor: 'shared-iterations',
      vus: 50,
      iterations: N_SEATS,
      startTime: '1m30s',
      maxDuration: '2m',
      exec: 'bookDistinctSeats',
    },
  },
  thresholds: {
    'http_req_duration{scenario:read_seats}': ['p(95)<200'],
    'http_req_duration{scenario:spread}': ['p(95)<800'],
    bookings_server_error_5xx: ['count==0'],
  },
};

function authHeaders(token, extra = {}) {
  return { headers: { Authorization: `Bearer ${token}`, ...extra } };
}

export function setup() {
  // Register + login users (bcrypt is slow, so do it once here, not in the test)
  const tokens = [];
  for (let i = 0; i < N_USERS; i++) {
    const body = JSON.stringify({
      name: `load${i}`,
      email: `load${RUN}_${i}@test.com`,
      password: 'password123',
    });
    http.post(`${BASE}/auth/register`, body, { headers: JSON_H });
    const res = http.post(
      `${BASE}/auth/login`,
      JSON.stringify({ email: `load${RUN}_${i}@test.com`, password: 'password123' }),
      { headers: JSON_H }
    );
    tokens.push(res.json('token'));
  }

  // The seed data only has 5 seats, so create more
  const createSeat = (n) => {
    http.post(
      `${BASE}/seats`,
      JSON.stringify({ seatNumber: n, status: 'AVAILABLE', event: { id: EVENT_ID } }),
      { headers: { ...JSON_H, Authorization: `Bearer ${tokens[0]}` } }
    );
  };

  createSeat(`HOT-${RUN}`);
  for (let i = 0; i < N_SEATS; i++) createSeat(`L${RUN}-${i}`);

  // POST /seats returns a boolean, so resolve ids from the uncached seat list
  const byNumber = {};
  const listRes = http.get(`${BASE}/seats/event/${EVENT_ID}`, authHeaders(tokens[0]));
  for (const s of listRes.json()) byNumber[s.seatNumber] = s.id;
  const hotSeat = byNumber[`HOT-${RUN}`];
  const seatIds = [];
  for (let i = 0; i < N_SEATS; i++) seatIds.push(byNumber[`L${RUN}-${i}`]);
  if (!hotSeat || seatIds.some((id) => !id)) {
    throw new Error('setup failed: could not resolve created seat ids');
  }

  return { tokens, hotSeat, seatIds };
}

function book(seatId, token) {
  const url =
    MODE === 'optimistic'
      ? `${BASE}/bookings/${seatId}`
      : `${BASE}/bookings/pessimistic/${seatId}`;
  const extra =
    MODE === 'optimistic'
      ? {}
      : { 'Idempotency-Key': `${RUN}-${exec.vu.idInTest}-${exec.vu.iterationInInstance}-${Math.random()}` };

  const res = http.post(url, null, authHeaders(token, extra));

  if (res.status >= 200 && res.status < 300) bookingOk.add(1);
  else if (res.status === 429) bookingRateLimited.add(1);
  else if (res.status >= 500) bookingServerError.add(1);
  else bookingRejected.add(1);
  return res;
}

export function readSeats() {
  const res = http.get(`${BASE}/events/${EVENT_ID}/seats`);
  check(res, { 'seats 200': (r) => r.status === 200 });
}

export function contendForOneSeat(data) {
  book(data.hotSeat, data.tokens[(exec.vu.idInTest - 1) % N_USERS]);
}

export function bookDistinctSeats(data) {
  const i = exec.scenario.iterationInTest;
  book(data.seatIds[i % N_SEATS], data.tokens[i % N_USERS]);
}
