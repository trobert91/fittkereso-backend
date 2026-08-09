## The Idea

The idea for this project came from spending a lot of time on Reddit searching for product recommendations. Google has become less useful for this purpose, as it's filled with SEO-driven articles that aren't always trustworthy. I found Reddit's personal experiences more valuable, but the fragmented nature of opinions made it hard to get a clear picture.

So, I decided to use LLMs to analyze Reddit data and rank products based on aggregated sentiment. After many iterations and a challenging first year, the platform has improved significantly and is now growing faster. The site is monetized through Amazon affiliate links, and it's finally generating enough income to justify the time invested.

I started documenting the process for myself, but thought sharing it could be helpful for feedback or for others to learn from.

---

## How the Data Pipeline Works

RedditRecs uses a data pipeline to analyze Reddit reviews and rank products. Here’s an overview:

1. **Define Product Types:** (e.g., Air purifier, Portable monitor)
2. **Collect Reddit Reviews:** Aggregate reviews by product models.
3. **Rank Models by Sentiment:** Use aggregated sentiment to rank products.
4. **Provide Shop Links:** Include links for each product model.

### Pipeline Steps

#### 1. Gather Relevant Reddit Threads

- Define product types.
- Generate search queries (e.g., "Best air fryer").
- Search Reddit (past year).
- Evaluate thread relevance using LLM.
- Save relevant thread data.
- Continue searching if relevance ≥ 40%; otherwise, move to next query.

#### 2. Extract Reviews

- Split large threads (preserving comment trees).
- Identify users with reviews via LLM.
- For each user:
    - Build context (subreddit, OP post, comment trees).
    - Extract review details:
        - Reddit username
        - Sentiment
        - Product info (brand, name, details)
        - Product URL (if present)
        - Verbatim quotes

#### 3. Map Reviews to Product Models

- Handle informal references (abbreviations, features, pluralization).
- Use a web research agent to infer possible product models.
- Save extracted product info to avoid duplication.
- Match researched models to database using name and description.

#### 4. Ranking

- Rank models by:
    - Number of positive sentiments
    - Positive/negative sentiment ratio
    - Specificity of model reference
- Scoring:
    - Each user = max 1 vote per model.
    - Votes spread if model not specified.
    - Popular models weighted higher.
    - Final score: 75% normalized positive sentiment + 25% positive/negative ratio.

#### 5. Manual Reconciliation

- Internal dashboard for error correction.
- Tool to group models into series (e.g., "Ninja grill").
- Grouping prevents rankings from being cluttered with similar models.

---

## Tech Stack & Tools

- **LLM APIs:** OpenAI (4o, o3-mini), Gemini (2.5 flash)
- **Data APIs:** Reddit PRAW, Google Search API, Amazon PAAPI, BrightData, FireCrawl, Jina.ai, Perplexity
- **Code:** Python (scripts), HTML, JavaScript, TypeScript, Nuxt (frontend)
- **Database:** Supabase
- **IDE:** Cursor
- **Deployment:** Replit (scripts), Cloudflare Pages (frontend)

---

## Ending Notes

I hope this overview was helpful. Let me know what you found interesting, what wasn’t, and if there’s anything else you’d like to know to help me improve the project.he idea for it came from finding myself trawling through Reddit a lot for product recomemndations. Google just sucks nowadays for product recs. Its clogged with SEO farm articles that can't be taken seriously. I very much preferred to hear people's personal experiences from Reddit. But it can be very overwhelming to try to make sense of the fragmented opinions scattered across Reddit.

So I thought why not use LLMs to analyze Reddit data and rank products according to aggregated sentiment? Went ahead and built it. Went through many many iterations over the year. The first 12 months was tought because there were a lot of issues to fix and growth was slow. But lots of things have been fixed and growth has started to accelerate recently. Gotta say i'm low-key proud of how it has evolved and how the traction has grown. The site is moneitzed by amazon affiliate. Didn't earn much at the start but it is finally starting to earn enough for me to not feel so terrible about the time i've invested into it lol.

Anyway I was documenting for myself how it works (might come in handy if I need to go back to a job lol). Thought I might as well share it so people can give feedback or learn from it.

How the data pipeline works
Core to RedditRecs is its data pipeline that analyzes Reddit data for reviews on products.

This is a gist of what the pipeline does:

Given a set of products types (e.g. Air purifier, Portable monitor etc)

Collect a list of reviews from reddit

That can be aggregated by product models

Such that the product models can be ranked by sentiment

And have shop links for each product model

The pipeline can be broken down into 5 main steps:

Gather Relevant Reddit Threads

Extract Reviews

Map Reviews to Product Models

Ranking

Manual Reconcillation

Step 1: Gather Relevant Reddit Threads
Gather as many relevant Reddit threads in the past year as (reasonably) possible to extract reviews for.

Define a list of products types

Generate search queries for each pre-defined product (e.g. Best air fryer, Air fryer recommendations)

For each search query:

Search Reddit up to past 1 year

For each page of search results

Evaluate relevance for each thread (if new) using LLM

Save thread data and relevance evaluation

Calculate cumulative relevance for all threads (new and old)

If >= 40% relevant, get next page of search results

If < 40% relevant, move on to next search query

Step 2: Extract Reviews
For each new thread:

Split thread if its too large (without splitting comment trees)

Identify users with reviews using LLM

For each unique user identified:

Construct relevant context (subreddit info + OP post + comment trees the user is part of)

Extract reviews from constructed context using LLM

Reddit username

Overall sentiment

Product info (brand, name, key details)

Product url (if present)

Verbatim quotes

Step 3: Map Reviews to Product Models
Now that we have extracted the reviews, we need to figure out which product model(s) each review is referring to.

This step turned out to be the most difficult part. It’s too complex to lay out the steps, so instead I'll give a gist of the problems and the approach I took. If you want to read more details you can read it on RedditRecs's blog.

Handling informal name references

The first challenge is that there are many ways to reference one product model:

A redditor may use abbreviations (e.g. "GPX 2" gaming mouse refers to the Logitech G Pro X Superlight 2)

A redditor may simply refer to a model by its features (e.g. "Ninja 6 in 1 dual basket")

Sometimes adding a "s" behind a model's name makes it a different model (e.g. the DJI Air 3 is distinct from the DJI Air 3s), but sometimes it doesn't (e.g. "I love my Smigot SM4s")

Related to this, a redditor’s reference could refer to multiple models:

A redditor may use a name that could refer to multiple models (e.g. "Roborock Qrevo" could refer to Qrevo S, Qrevo Curv etc")

When a redditor refers to a model by it features (e.g. "Ninja 6 in 1 dual basket"), there could be multiple models with those features

So it is all very context dependent. But this is actually a pretty good use case for an LLM web research agent.

So what I did was to have a web research agent research the extracted product info using Google and infer from the results all the possible product model(s) it could be.

Each extracted product info is saved to prevent duplicate work when another review has the exact same extracted product info.

Distinguishing unique models

But theres another problem.

After researching the extracted product info, let’s say the agent found that most likely the redditor was referring to “model A”. How do we know if “model A” corresponds to an existing model in the database?

What is the unique identifier to distinguish one model from another?

The approach I ended up with is to use the model name and description (specs & features) as the unique identifier, and use string matching and LLMs to compare and match models.

Step 4: Ranking
The ranking aims to show which Air Purifiers are the most well reviewed.

Key ranking factors:

The number of positive user sentiments

The ratio of positive to negative user sentiment

How specific the user was in their reference to the model

Scoring mechanism:

Each user contributes up to 1 "vote" per model, regardless of no. of comments on it.

A user's vote is less than 1 if the user does not specify the exact model - their 1 vote is "spread out" among the possible models.

More popular models are given more weight (to account for the higher likelihood that they are the model being referred to).

Score calculation for ranking:

I combined the normalized positive sentiment score and the normalized positive:negative ratio (weighted 75%-25%)

This score is used to rank the models in descending order

Step 5: Manual Reconciliation
I have an internal dashboard to help me catch and fix errors more easily than trying to edit the database via the native database viewer (highly vibe coded)

This includes a tool to group models as series.

The reason why series exists is because in some cases, depending on the product, you could have most redditors not specifying the exact model. Instead, they just refer to their product as “Ninja grill” for example.

If I do not group them as series, the rankings could end up being clogged up with various Ninja grill models, which is not meaningful to users (considering that most people don’t bother to specify the exact models when reviewing them).

Tech Stack & Tools
LLM APIs

OpenAI (mainly 4o and o3-mini)

Gemini (mainly 2.5 flash)

Data APIs

Reddit PRAW

Google Search API

Amazon PAAPI (for amazon data & generating affiliate links)

BrightData (for scraping common ecommerce sites like Walmart, BestBuy etc)

FireCrawl (for scraping other web pages)

Jina.ai (backup scraper if FireCrawl fails)

Perplexity (for very simple web research only)

Code

Python (for script)

HTML, Javascript, Typescript, Nuxt (for frontend)

Database

Supabase

IDE

Cursor

Deployment

Replit (script)

Cloudlfare Pages (frontend)

Ending notes
I hope that made sense and was helpful? Kinda just dumped out what was in my head in one day. Let me know what was interesting, what wasn't, and if theres anything else you'd like to know to help me improve it.
