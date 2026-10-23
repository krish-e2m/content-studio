// ---------------------------------------------------------------------------
// postContent.js
// Body copy and comment threads for the published posts in performanceData.js.
// Kept separate so PLATFORM_POSTS stays a metrics table — this file is the
// human-readable side of the same posts, keyed by the identical post ids.
//
// When live APIs are wired up, `body` maps to the post's message/caption field
// and `comments` to the platform's comments edge; the shapes below already
// match what those endpoints return (author, handle, text, likes, timeAgo).
// ---------------------------------------------------------------------------

const BODY = {
  'fb-1': `Willpower is a battery. Systems are a power outlet.\n\nEvery creator I know who posts consistently has stopped relying on motivation. They built a repeatable loop instead: capture ideas as they happen, batch the writing, schedule ahead.\n\nThe result isn't that they feel more disciplined. It's that they need less discipline to begin with.`,
  'fb-2': `The mistake isn't posting too little. It's planning in the wrong unit.\n\nMost people plan post by post. The ones who stay consistent plan in themes — a month of related ideas that feed each other, so no single post has to carry the whole week.`,
  'fb-3': `One idea. Five platforms. Zero copy-paste.\n\nRepurposing isn't reposting. It's asking what shape this idea takes in each room: the long version for the newsletter, the argument for LinkedIn, the hook for X, the visual for Instagram.`,
  'fb-4': `Nobody tells you that reinvention mostly looks like admin.\n\nIt's rescheduling the thing. It's the fourth draft. It's telling people what you do now and watching them not quite get it yet. The dramatic part is maybe 5% of it.`,
  'fb-5': `We rebuilt our five most-used templates this month and engagement moved more than any caption change we've tried.\n\nTurns out the format was doing more work than the words.`,
  'fb-6': `A headline's job isn't to be clever. It's to make the next line unavoidable.\n\nWrite the post first. Then pull the sharpest sentence out of the middle and put it at the top.`,
  'fb-7': `Spent the week automating client onboarding. Here's the honest breakdown of what actually saved time versus what just felt productive.`,
  'fb-8': `Our whole weekly workflow, start to finish. Monday plan, Tuesday batch, Wednesday design, Thursday schedule, Friday review. No heroics.`,

  'ig-1': `Stop waiting for the perfect moment ✨\n\nThe perfect moment is a scheduling problem disguised as a feelings problem. Pick the day. Put it in the calendar. Let the calendar be braver than you are.`,
  'ig-2': `Three hours. One sitting. A whole month of content.\n\nHere's what actually goes in the block: 30 min outlining, 90 min writing, 30 min visuals, 30 min scheduling. That's it.`,
  'ig-3': `5 signs your content strategy is actually working →\n\n(Swipe. Number 4 is the one nobody talks about.)`,
  'ig-4': `Behind the scenes of a monthly planning session. Sped up, because the real thing takes three coffees. ☕`,
  'ig-5': `The desk setup that finally stopped fighting me. Nothing expensive — just fewer things.`,
  'ig-6': `How we structure client calendar boards →\n\nOne column per pillar, one row per week. That's the whole system.`,
  'ig-7': `3 editing tricks for video carousels. The third one saves me about an hour a week.`,
  'ig-8': `Quotes that kept us grounded this month. Save this one for the week it stops being fun.`,

  'li-1': `Everyone's asking whether AI-written content still resonates.\n\nAfter reviewing six months of our own performance data, the pattern isn't about who or what wrote it. The posts that landed had a specific claim, a real number, or a genuine change of mind. The posts that didn't were fluent and forgettable.\n\nFluency was never the scarce thing. A point of view is.`,
  'li-2': `Three pillars. That's it. That's the system.\n\n1. What we're learning (in public, while it's still messy)\n2. What we're building (with the parts that didn't work)\n3. What we believe (the opinions we'd defend)\n\nEvery post fits one. If it fits none, it doesn't get written.`,
  'li-3': `Gave a conference talk last month. Turned it into an article in four steps — transcript, cut, restructure, rewrite the open. Full breakdown below.`,
  'li-4': `The single change that improved my writing most wasn't a course. It was shortening the feedback loop from weeks to days.`,
  'li-5': `Impressions are a vanity metric for B2B and we should stop reporting them as headline numbers.\n\nWhat we track instead: replies from people in the buying committee, saves, and how many conversations start with "I read your post."`,
  'li-6': `A content engine for a small agency doesn't mean more tools. It means fewer decisions per post.`,
  'li-7': `10+ active channels, no drop in quality. The honest answer is that we don't treat them equally — two are primary, the rest are derivatives.`,
  'li-8': `The exact review framework we run every post through before it ships. Four questions, five minutes.`,

  'x-1': `Most people overcomplicate content.\n\nThe fix isn't a better tool. It's writing the thing down the day you think of it.`,
  'x-2': `Capture → repurpose → schedule.\n\nThe whole loop in 5 tweets. 🧵`,
  'x-3': `Authenticity isn't a tone. It's a willingness to be specific.`,
  'x-4': `Unpopular opinion: simple text posts beat fancy graphics on X 9/10 times.\n\nThe graphic is a speed bump between the reader and the idea.`,
  'x-5': `The 15-minute daily engagement habit for founders on X:\n\n5 min replying to people smaller than you\n5 min replying to people bigger than you\n5 min posting your own thing`,
  'x-6': `7 hook templates that stop the scroll. 🧵`,
  'x-7': `Your content system should work on your worst energy day.\n\nIf it only works when you're inspired, it's not a system. It's a mood.`,

  'ss-1': `There's a version of this newsletter I've started four times and never sent, because I kept trying to write it on willpower.\n\nThis week I want to make the case that almost everything we diagnose as a discipline problem is actually a systems problem wearing a costume. When you can't get yourself to do the thing repeatedly, the useful question usually isn't "why am I like this" — it's "what would make the next repetition require less of me."\n\nBelow: the three places a content system usually breaks, and what to put there instead.`,
  'ss-2': `Build the thing once, then feed it.\n\nThe most common mistake I see is rebuilding the machine every month — new template, new tool, new format — and never getting to the part where it just runs.`,
  'ss-3': `What midlife content actually looks like when it's honest: less arrival, more revision. This one got personal.`,
  'ss-4': `A weekly writing ritual isn't about the time of day. It's about what makes starting cheap.`,
  'ss-5': `Long-form builds trust for a boring reason: it's expensive to fake. Here's what the numbers looked like when we tested it.`,
  'ss-6': `Three subject-line patterns that moved our click-through rate, with the actual before/after numbers.`,
}

// Small, believable comment threads. Counts don't try to match the metric
// totals exactly — these are the visible top comments, the way a real feed
// shows a few and hides the rest behind "view all".
const COMMENTS = {
  'fb-1': [
    { author: 'Dana Whitfield', text: 'The battery/outlet framing finally made this click for me. Saving.', likes: 12, timeAgo: '2d' },
    { author: 'Marcus Bell', text: 'Genuinely how long did it take before the loop felt automatic?', likes: 4, timeAgo: '2d' },
    { author: 'Priya Raman', text: 'Needed this today, thank you.', likes: 7, timeAgo: '1d' },
  ],
  'fb-2': [
    { author: 'Tom Ackerley', text: 'Planning in themes instead of posts changed my whole month.', likes: 9, timeAgo: '5d' },
    { author: 'Lena Fischer', text: 'Do you plan a month at a time or a quarter?', likes: 3, timeAgo: '4d' },
  ],
  'fb-3': [
    { author: 'Ravi Menon', text: '"Repurposing isn\'t reposting" — putting that on a sticky note.', likes: 21, timeAgo: '1w' },
    { author: 'Claire Dubois', text: 'The newsletter → LinkedIn step is where I always lose steam.', likes: 6, timeAgo: '6d' },
    { author: 'Sam Okafor', text: 'Would love a template for this if you ever make one.', likes: 11, timeAgo: '5d' },
  ],
  'fb-4': [
    { author: 'Helen Nakamura', text: 'The 5% line hit hard. Mostly admin is exactly right.', likes: 34, timeAgo: '1w' },
    { author: 'Jonah Reid', text: 'Thank you for saying the unglamorous part out loud.', likes: 18, timeAgo: '1w' },
  ],
  'fb-5': [
    { author: 'Aisha Karim', text: 'Which of the five performed best?', likes: 5, timeAgo: '2w' },
    { author: 'Peter Lindqvist', text: 'Format over words is underrated, agreed.', likes: 8, timeAgo: '2w' },
  ],
  'fb-6': [{ author: 'Grace Mwangi', text: 'Pulling the headline out of the middle — trying this on my next draft.', likes: 14, timeAgo: '3w' }],
  'fb-7': [{ author: 'Oliver Grant', text: 'Curious what turned out to be the "felt productive" bucket.', likes: 6, timeAgo: '3w' }],
  'fb-8': [{ author: 'Nina Petrova', text: 'No heroics is the whole point. Love the simplicity.', likes: 10, timeAgo: '1mo' }],

  'ig-1': [
    { author: 'sarah.builds', text: 'the calendar being braver than me 😭 accurate', likes: 42, timeAgo: '3d' },
    { author: 'mattkhoury', text: 'needed to read this exact sentence today', likes: 18, timeAgo: '3d' },
    { author: 'thequietstudio', text: '✨✨✨', likes: 5, timeAgo: '2d' },
  ],
  'ig-2': [
    { author: 'jessmakes', text: 'ok but 30 min for visuals is fast, what are you using?', likes: 27, timeAgo: '1w' },
    { author: 'daniel.co', text: 'tried this last sunday and it actually worked', likes: 15, timeAgo: '6d' },
  ],
  'ig-3': [
    { author: 'contentwithamy', text: 'slide 4 👏👏', likes: 56, timeAgo: '1w' },
    { author: 'brandbyroza', text: 'saving this whole carousel', likes: 31, timeAgo: '1w' },
    { author: 'leo.writes', text: 'the 4th one is the one nobody wants to hear lol', likes: 22, timeAgo: '5d' },
  ],
  'ig-4': [{ author: 'studionorth', text: 'three coffees is honest 😂', likes: 19, timeAgo: '2w' }],
  'ig-5': [{ author: 'minimal.desk', text: 'fewer things > expensive things', likes: 44, timeAgo: '3w' }],
  'ig-6': [{ author: 'agencylife.co', text: 'one column per pillar is so clean', likes: 12, timeAgo: '4w' }],
  'ig-7': [{ author: 'editwithkai', text: 'trick 3 saved me so much time thank you', likes: 26, timeAgo: '1mo' }],
  'ig-8': [{ author: 'quietmornings', text: 'saved for the hard week 🤍', likes: 33, timeAgo: '1mo' }],

  'li-1': [
    { author: 'Elena Vasquez', role: 'Head of Content, Northwind', text: 'The "fluency was never the scarce thing" line is the whole post. We\'re seeing the same in our data — specificity outperforms polish consistently.', likes: 48, timeAgo: '3d' },
    { author: 'David Chen', role: 'Founder, Loop Studio', text: 'Would be curious whether this holds for top-of-funnel vs. bottom-of-funnel content. Our TOFU numbers tell a slightly different story.', likes: 12, timeAgo: '2d' },
    { author: 'Amara Osei', role: 'B2B Marketing Consultant', text: 'Sharing this with my team. The "changed my mind" criterion is a great editorial filter.', likes: 21, timeAgo: '2d' },
  ],
  'li-2': [
    { author: 'Thomas Lindgren', role: 'Content Lead, Sable', text: 'The "if it fits none, it doesn\'t get written" rule is the hard part. Most people add a fourth pillar instead.', likes: 37, timeAgo: '1w' },
    { author: 'Rachel Kim', role: 'Freelance Writer', text: 'Pillar 1 in particular — publishing while it\'s still messy takes real nerve.', likes: 14, timeAgo: '6d' },
  ],
  'li-3': [{ author: 'Michael Brennan', role: 'Speaker Coach', text: 'The restructure step is where most people stop. Good breakdown.', likes: 16, timeAgo: '2w' }],
  'li-4': [{ author: 'Sofia Almeida', role: 'Editor', text: 'Shortening the loop beats any course, agreed. Who gives you feedback now?', likes: 23, timeAgo: '3w' }],
  'li-5': [
    { author: 'Ben Hartley', role: 'Demand Gen, Arcadia', text: 'Finally. Impressions as a headline metric has done real damage to B2B reporting.', likes: 62, timeAgo: '1mo' },
    { author: 'Yuki Tanaka', role: 'CMO', text: '"I read your post" as a tracked metric is genuinely clever.', likes: 29, timeAgo: '1mo' },
  ],
  'li-6': [{ author: 'Chris Doyle', role: 'Agency Owner', text: 'Fewer decisions per post — that reframe is worth the read alone.', likes: 18, timeAgo: '1mo' }],
  'li-7': [{ author: 'Marta Nowak', role: 'Social Lead', text: 'The honesty about not treating channels equally is refreshing.', likes: 25, timeAgo: '2mo' }],
  'li-8': [{ author: 'Isaac Fields', role: 'Copy Chief', text: 'Four questions in five minutes is the right size for a review gate.', likes: 20, timeAgo: '2mo' }],

  'x-1': [
    { author: 'Nate Rivera', handle: '@naterivera', text: 'the day you think of it is the whole trick', likes: 34, timeAgo: '2d' },
    { author: 'Kim Lawson', handle: '@kimlawson', text: 'guilty of buying the tool instead', likes: 12, timeAgo: '2d' },
  ],
  'x-2': [{ author: 'Owen Fitz', handle: '@owenfitz', text: 'best 5-tweet thread on this I\'ve seen', likes: 47, timeAgo: '1w' }],
  'x-3': [
    { author: 'Priya S', handle: '@priyaswrites', text: 'specificity > sincerity signaling', likes: 88, timeAgo: '2w' },
    { author: 'Deb Klein', handle: '@debklein', text: 'quoting this', likes: 19, timeAgo: '2w' },
  ],
  'x-4': [{ author: 'Alex Moreau', handle: '@alexmoreau', text: 'the graphic as speed bump is a great way to put it', likes: 56, timeAgo: '3w' }],
  'x-5': [{ author: 'Ruth Adeyemi', handle: '@ruthadeyemi', text: 'the "smaller than you" 5 min is the part everyone skips', likes: 41, timeAgo: '1mo' }],
  'x-6': [{ author: 'Jay Patel', handle: '@jaypatel', text: 'hook 4 works absurdly well, can confirm', likes: 63, timeAgo: '1mo' }],
  'x-7': [{ author: 'Simone Bright', handle: '@simonebright', text: 'not a system, a mood 💀 calling myself out', likes: 102, timeAgo: '2mo' }],

  'ss-1': [
    { author: 'Margaret Hollis', text: 'The "systems problem wearing a costume" framing is going to stay with me. I\'ve spent years treating this as a character flaw.', likes: 28, timeAgo: '4d' },
    { author: 'Andrew Pace', text: 'Started four times and never sent — I felt that in my chest. Glad this one made it out.', likes: 15, timeAgo: '3d' },
  ],
  'ss-2': [{ author: 'Fiona Clarke', text: 'Rebuilding the machine every month is exactly my problem. Thank you for naming it.', likes: 22, timeAgo: '2w' }],
  'ss-3': [
    { author: 'Robert Iwu', text: 'Less arrival, more revision. This is the most honest thing I\'ve read about this all year.', likes: 44, timeAgo: '1mo' },
    { author: 'Susan Doyle', text: 'Please write more like this one.', likes: 19, timeAgo: '1mo' },
  ],
  'ss-4': [{ author: 'Tessa Grant', text: '"What makes starting cheap" is the reframe I needed.', likes: 17, timeAgo: '2mo' }],
  'ss-5': [{ author: 'Hugo Marchetti', text: 'Expensive to fake — that\'s the trust mechanism exactly.', likes: 31, timeAgo: '2mo' }],
  'ss-6': [{ author: 'Bea Lindstrom', text: 'Appreciate you sharing the actual before/after instead of just the pattern.', likes: 26, timeAgo: '3mo' }],
}

export function getPostBody(post) {
  return BODY[post?.id] || post?.title || ''
}

export function getPostComments(post) {
  return COMMENTS[post?.id] || []
}
