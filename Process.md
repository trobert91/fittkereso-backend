# Step 1: Gather Relevant Reddit Threads

1. **Define Product Types**
    - Create a list of product types to research.

2. **Generate Search Queries**
    - For each product type, generate relevant search queries (e.g., "Best air fryer", "Air fryer recommendations").

========================================

3. **Search Reddit (Past Year)**
    - Use each search query to find Reddit threads from the past year.

4. **Evaluate Threads**
    - For each page of search results:
      - For each new thread, evaluate relevance using an LLM.
      - Save thread data and relevance evaluation.

5. **Calculate Cumulative Relevance**
    - Assess cumulative relevance for all threads (new and old).

6. **Determine Next Steps**
    - If cumulative relevance is **≥ 40%**, proceed to the next page of search results.
    - If cumulative relevance is **< 40%**, move on to the next search query.

## Step 2: Extract Reviews

For each new thread:

1. **Split Large Threads**
    - If a thread is too large, split it into manageable chunks without breaking up comment trees.

2. **Identify Reviewers**
    - Use an LLM to identify users who have posted reviews.

3. **Construct Context**
    - For each unique user identified:
        - Gather relevant context, including subreddit info, the original post, and all comment trees the user is part of.

4. **Extract Review Data**
    - Use an LLM to extract the following from the constructed context:
        - Reddit username
        - Overall sentiment
        - Product information (brand, name, key details)
        - Product URL (if present)
        - Verbatim quotes

---

## Step 3: Map Reviews to Product Models

Now that reviews are extracted, map each review to the correct product model(s):

- **Informal References**
    - Handle abbreviations, feature-based references, and pluralization (e.g., "GPX 2" for "Logitech G Pro X Superlight 2", "Ninja 6 in 1 dual basket").
    - Account for ambiguous references that could point to multiple models.

- **Contextual Mapping**
    - Use an LLM web research agent to search Google for the extracted product info and infer all possible matching product models.
    - Cache extracted product info to avoid duplicate research.

- **Unique Model Identification**
    - Use model name and description (specs & features) as unique identifiers.
    - Apply string matching and LLMs to compare and match models in the database.

---

## Step 4: Ranking

Rank models based on review data:

- **Ranking Factors**
    - Number of positive user sentiments
    - Ratio of positive to negative sentiment
    - Specificity of user references to the model

- **Scoring Mechanism**
    - Each user contributes up to 1 vote per model.
    - If a user is ambiguous, their vote is distributed among possible models.
    - More popular models receive more weight.

- **Score Calculation**
    - Combine normalized positive sentiment score and normalized positive:negative ratio (weighted 75%-25%).
    - Rank models in descending order by score.

---

## Step 5: Manual Reconciliation

Use an internal dashboard for error correction and model grouping:

- **Series Grouping**
    - Group models into series to avoid fragmented rankings when users refer to products generically (e.g., "Ninja grill").

---

## Tech Stack & Tools

- **LLM APIs:** OpenAI (4o, o3-mini), Gemini (2.5 flash)
- **Data APIs:** Reddit PRAW, Google Search API, Amazon PAAPI, BrightData, FireCrawl, Jina.ai, Perplexity
- **Code:** Python (script), HTML, Javascript, Typescript, Nuxt (frontend)
- **Database:** Supabase
- **IDE:** Cursor
- **Deployment:** Replit (script), Cloudflare Pages (frontend)

---

## Ending Notes

I hope this overview was helpful! Let me know what was interesting, what wasn't, and if there's anything else you'd like to know.
