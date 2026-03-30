# On-Chain Farm

A fully on-chain game built on Ethereum where players (and AI agents) compete to grow crops, cook dishes, and sell them in a real-time reverse auction market. No servers, no oracles — all game state lives on-chain.

## How It Works

The game is a six-step economic loop:

1. **Bid for Land** — Win one of 100 unique plots in sequential English auctions
2. **Buy Seeds** — Purchase seed tokens from the Seed Shop with ETH
3. **Plant & Grow** — Plant seeds on your land; crops mature on a blockchain timer
4. **Harvest** — Claim fruit tokens during the maturity window before they rot
5. **Cook** — Burn fruit tokens to craft dish tokens following recipes
6. **Sell** — Submit dish offers to the reverse auction; the cheapest offers win ETH

All ETH paid for seeds, land, and cleanup fees flows into the DishMarket treasury, which funds the winner payouts. The game is self-sustaining.

---

## Smart Contracts

### LandAuction

Sequential English auction for 100 land plots (IDs 0–99). Plots are auctioned one at a time.

- First bid starts a 60-second countdown; each new bid must beat the current highest
- When the auction closes, the winner receives the land and proceeds go to the DishMarket treasury
- Outbid players claim refunds via pull-payment (`withdrawRefund`)
- After one auction settles, the next plot becomes available

### SeedShop

Sells 20 types of seed tokens at fixed ETH prices. Revenue is forwarded to the DishMarket treasury.

| Category | Seeds |
|---|---|
| Vegetables | Tomato, Lettuce, Carrot, Potato, Onion, Pepper, Cucumber, Spinach, Pumpkin, Broccoli |
| Fruits | Strawberry, Watermelon, Blueberry, Mango, Pineapple, Lemon, Grape, Peach, Cherry, Melon |

Prices range from 0.00002 ETH (Onion) to 0.0002 ETH (Pineapple).

### FarmManager

Manages the land state machine: `Empty → Growing → Mature → Rotten → NeedsCleanup → Empty`

Land state is computed from `block.timestamp` — nothing is stored per-block, so time moves naturally.

| Parameter | Range |
|---|---|
| Max capacity per land | 5–40 seeds |
| Maturation time | 120–420 seconds |
| Rot window (harvestable) | 60–180 seconds |
| Harvest yield | 2–6 fruit tokens per seed |
| Cleanup cost | 0.000001–0.000006 ETH |

Planting burns SeedTokens. Harvesting mints FruitTokens. Cleanup fees go to the DishMarket treasury.

### Chef

Cooks dish tokens from fruit token ingredients. One active cooking session per (user, recipe) at a time; multiple recipes can be cooked in parallel.

10 recipes available:

| Dish | Key Ingredients | Cook Time |
|---|---|---|
| Tomato Soup | Tomato | 60s |
| Green Salad | Lettuce, Cucumber, Spinach | 120s |
| Lemonade | Lemon | 90s |
| Carrot Cake | Carrot, Pumpkin | 180s |
| Pumpkin Pie | Pumpkin, Potato | 240s |
| Mango Juice | Mango | 120s |
| Watermelon Smoothie | Watermelon, Strawberry | 150s |
| Fruit Salad | Strawberry, Grape, Blueberry, Peach | 300s |
| Pineapple Sorbet | Pineapple, Lemon, Mango | 420s |
| Mixed Pickle | Carrot, Cucumber, Onion, Pepper | 360s |

`startCooking(recipeId, qty)` burns ingredients. `claim(recipeId)` mints dishes after `prepTime` elapses.

### DishMarket

Demand-driven reverse auction. Every 10 seconds (one **epoch**) the market demands **two dishes**. The 5 cheapest offers per demanded dish win ETH from the treasury.

**Epoch mechanics:**
- `epoch = block.timestamp / 10`
- **Primary demand:** `epoch % recipeCount` — fully predictable, agents can plan ahead
- **Secondary demand:** `block.prevrandao % recipeCount` — beacon-chain randomness, snapshotted on first offer of the epoch

**Submitting an offer (`submitOffer(recipeId, askPrice, amount)`):**
- The submitted `recipeId` must be the current primary or secondary demand
- Dishes are escrowed; the matching ETH commitment is reserved from `availableFunds`
- One offer per address per recipe per epoch
- Ask price is capped at `seedCost × 20` (or `× 30` for recipes with 4+ ingredients)

**Settling (`settle(epoch, offerIndex)`):**
- Callable after the epoch ends
- An offer wins if `askPrice <= getWinnerCutoff(epoch, recipeId)` (the MAX_WINNERS-th cheapest ask)
- Winner receives ETH; dishes are burned
- Ties at the cutoff also win

**Withdrawing (`withdrawOffer(epoch, offerIndex)`):**
- Non-winners reclaim escrowed dishes and release their reserved funds
- During an active epoch: the current lowest-ask holder cannot withdraw (prevents gaming)

**Owner operations:**
- `withdrawFunds(amount)` — withdraw uncommitted treasury funds
- `rescueStaleOffer(epoch, offerIndex)` — after 100 epochs with no settlement, owner can rescue abandoned offers, returning dishes to seller and restoring funds to treasury

**View helpers:**
- `currentDemand()` / `currentSecondDemand()` — currently demanded recipe IDs
- `getWinnerCutoff(epoch, recipeId)` — current cutoff ask price (O(1) winner check)
- `getOffers(epoch)` — all offers for an epoch
- `minuteState(epoch)` — epoch snapshot (recipeId, secondRecipeId, winner indices, ask prices)

### Token Contracts

All tokens are ERC20 with 0 decimals — 1 token = 1 game unit.

| Token | Minted By | Burned By |
|---|---|---|
| SeedToken (20 types) | SeedShop | FarmManager (on plant) |
| FruitToken (20 types) | FarmManager (on harvest) | Chef (on startCooking) |
| DishToken (10 types) | Chef (on claim) | DishMarket (on settle) |

---

## Economy

```
Player ETH
    ↓
LandAuction (bid) ──────────────────→ DishMarket treasury
SeedShop (buy)   ──────────────────→ DishMarket treasury
FarmManager (cleanup fees) ────────→ DishMarket treasury
                                             ↓
                                  Funds winner payouts
                                             ↑
Player: plant → harvest → cook → offer → win ETH
```

The treasury is replenished continuously by player activity, creating a sustainable loop.

---

## Development

### Requirements

- [Node >= v20.18.3](https://nodejs.org/en/download/)
- [Yarn v1 or v2+](https://classic.yarnpkg.com/en/docs/install/)
- [Git](https://git-scm.com/downloads)

### Local Setup

```bash
# Install dependencies
yarn install

# Terminal 1: start local Hardhat blockchain
yarn chain

# Terminal 2: deploy all contracts
yarn deploy

# Terminal 3: start the Next.js frontend
yarn start
```

Visit `http://localhost:3000`.

### Testing

```bash
# Run all contract tests (54 tests)
yarn hardhat:test

# Run tests for a specific contract
cd packages/hardhat && npx hardhat test test/DishMarket.ts --network hardhat
```

Test files in `packages/hardhat/test/`:

| File | Coverage |
|---|---|
| `LandAuction.ts` | Bidding, settlement, refunds |
| `SeedShop.ts` | Seed registration and purchasing |
| `FarmManager.ts` | Planting, harvesting, state transitions, cleanup |
| `Chef.ts` | Recipe registration, cooking flow, timing |
| `DishMarket.ts` | Offer submission, settlement, winner selection, funds commitment, rescue |
| `Integration.ts` | End-to-end game flow across contracts |

### Building

```bash
yarn compile        # Compile Solidity contracts
yarn next:build     # Build Next.js frontend
yarn lint           # Lint both packages
```

---

## Scripts

### Farm Bot (`farmBot.ts`)

Autonomous agent that plays the full game loop:

1. Bids on land (up to 3 plots)
2. Looks 12 epochs ahead to predict demand and plans seed purchases accordingly
3. Plants, harvests, and cleans up on a tight schedule
4. Cooks multiple recipes in parallel
5. Submits the lowest viable ask for demanded dishes
6. Settles winning offers and withdraws losing ones

```bash
yarn bot
# or
cd packages/hardhat && npx hardhat run scripts/farmBot.ts --network localhost
```

**Key constants:**
- `MAX_LANDS = 3` — how many land plots to acquire
- `ASK_PRICE_PCT = 120%` — ask price as percentage of seed cost
- `LOOKAHEAD_MINUTES = 12` — planning horizon in epochs

### Simulation (`simulate.ts`)

Monte Carlo economy simulation: 30 bots across 6 archetypes competing over 48 simulated hours.

| Archetype | Strategy |
|---|---|
| Speed Runners | Fast/cheap recipes, thin margins |
| Premium Chefs | Expensive multi-ingredient recipes, high margins |
| Generalists | All recipes, moderate margins |
| Snipers | Niche recipes, only sell when demand is uncontested |
| Batch Masters | Max batch size, volume focus |
| Loners | Conservative, avoid competition |

```bash
npx tsx packages/hardhat/scripts/simulate.ts
```

Outputs per-bot revenue, settlement rates, ask price distributions, and archetype rankings.

---

## Frontend Pages

| Route | Description |
|---|---|
| `/` | Game overview, how to play, token economy diagram |
| `/farm` | Land auction, planting/harvesting controls, land state timers |
| `/shop` | Seed catalog with farming stats and recipe cross-references |
| `/dishes` | Recipe cards, cooking controls, claim buttons, offer submission |
| `/debug` | Raw contract read/write UI (all 8 contracts) |

---

## Project Structure

```
packages/
  hardhat/
    contracts/          # Solidity contracts
    deploy/             # Deployment scripts (01–05)
    scripts/            # farmBot.ts, simulate.ts
    test/               # Mocha/Chai test suites
  nextjs/
    app/                # Next.js App Router pages
    contracts/          # Auto-generated ABIs (deployedContracts.ts)
    hooks/              # scaffold-eth React hooks
```

---

## Deploy to a Live Network

```bash
# Configure your deployer key
yarn generate           # or: yarn account:import

# Deploy
yarn deploy --network baseSepolia

# Verify contracts
yarn verify --network baseSepolia

# Deploy frontend
yarn vercel:yolo --prod
```

Supported networks: Mainnet, Sepolia, Base, Base Sepolia, Arbitrum, Optimism, Polygon, Gnosis, Scroll, Celo (and their testnets). Add more in `packages/hardhat/hardhat.config.ts`.
