const dns = require('node:dns');
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
dotenv.config();

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const Stripe = require('stripe');

const app = express();
const port = process.env.PORT || 5000;
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ⚠️ IMPORTANT: Webhook route MUST come BEFORE express.json()
// Stripe needs raw body to verify webhook signature
// app.post(
//   "/webhook",
//   express.raw({ type: "application/json" }),
//   async (req, res) => {
//     const sig = req.headers["stripe-signature"];
//     let event;

//     try {
//       event = stripe.webhooks.constructEvent(
//         req.body,
//         sig,
//         process.env.STRIPE_WEBHOOK_SECRET
//       );
//     } catch (err) {
//       console.error("❌ Webhook signature error:", err.message);
//       return res.status(400).send(`Webhook Error: ${err.message}`);
//     }

//     // ── checkout.session.completed → plan upgrade
//     if (
//       event.type === "checkout.session.completed" ||
//       event.type === "invoice.payment_succeeded"
//     ) {
//       const session = event.data.object;
//       const customerEmail = session.customer_email || session.metadata?.email;
//       const plan = session.metadata?.plan || "pro";

//       if (customerEmail) {
//         try {
//           await usersCollection.updateOne(
//             { email: customerEmail },
//             {
//               $set: {
//                 plan,
//                 stripeCustomerId: session.customer,
//                 subscriptionId: session.subscription,
//                 planUpdatedAt: new Date(),
//                 appliedThisMonth: 0,
//               },
//             }
//           );
//           console.log(`✅ Plan upgraded: ${customerEmail} → ${plan}`);
//         } catch (err) {
//           console.error("❌ DB update error:", err.message);
//         }
//       }
//     }

//     // ── subscription cancelled → reset to free
//     if (event.type === "customer.subscription.deleted") {
//       const subscription = event.data.object;
//       try {
//         await usersCollection.updateOne(
//           { subscriptionId: subscription.id },
//           {
//             $set: {
//               plan: "free",
//               subscriptionId: null,
//               planUpdatedAt: new Date(),
//             },
//           }
//         );
//         console.log("✅ Subscription cancelled → plan reset to free");
//       } catch (err) {
//         console.error("❌ DB update error:", err.message);
//       }
//     }

//     res.json({ received: true });
//   }
// );

// ── Now apply JSON middleware for all other routes
app.use(cors());
app.use(express.json());

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// Declared outside run() so webhook handler can access it
let usersCollection;

app.get("/", (req, res) => {
  res.send("HireLoop Server is running!");
});

async function run() {
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    console.log("✅ Connected to MongoDB!");

    const db = client.db("hireLoop");
    const companiesCollection = db.collection("companies");
    const jobsCollection = db.collection("jobs");
    const applicationsCollection = db.collection("applications");
    const savedJobsCollection = db.collection("savedJobs");
    usersCollection = db.collection("user"); // BetterAuth user collection


    // ════════════════════════════════════════════
    // COMPANIES ROUTES
    // ════════════════════════════════════════════

    // POST /companies — Recruiter company register
    app.post("/companies", async (req, res) => {
      try {
        const company = req.body;
        company.status = "pending";
        company.createdAt = new Date();
        const result = await companiesCollection.insertOne(company);
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    // GET /companies — সব APPROVED company (Public)
    app.get("/companies", async (req, res) => {
      try {
        const { industry, search } = req.query;
        const filter = { status: "approved" };
        if (industry) filter.industry = industry;
        if (search) filter.name = { $regex: search, $options: "i" };
        const companies = await companiesCollection
          .find(filter)
          .sort({ createdAt: -1 })
          .toArray();
        res.send(companies);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    // GET /companies/my-company — Recruiter এর নিজের company
    app.get("/companies/my-company", async (req, res) => {
      try {
        const email = req.query.email;
        if (!email) return res.send(null);
        const company = await companiesCollection.findOne({ recruiterEmail: email });
        res.send(company || null);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    // GET /companies/:id — single company details
    app.get("/companies/:id", async (req, res) => {
      try {
        const company = await companiesCollection.findOne({ _id: new ObjectId(req.params.id) });
        if (!company) return res.status(404).send({ message: "Company not found" });
        res.send(company);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    // PUT /companies/:id — company info update
    app.put("/companies/:id", async (req, res) => {
      try {
        const updatedData = req.body;
        delete updatedData._id;
        updatedData.status = "pending";
        const result = await companiesCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: updatedData }
        );
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });


    // ════════════════════════════════════════════
    // JOBS ROUTES
    // ════════════════════════════════════════════

    // POST /jobs — Recruiter নতুন job post
    app.post("/jobs", async (req, res) => {
      try {
        const job = req.body;
        job.status = job.status || "active";
        job.applicantsCount = 0;
        job.createdAt = new Date();
        const result = await jobsCollection.insertOne(job);
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    // GET /jobs — সব ACTIVE job (Public, filters সহ)
    app.get("/jobs", async (req, res) => {
      try {
        const { search, category, jobType, location } = req.query;
        const filter = { status: "active" };
        if (search) filter.title = { $regex: search, $options: "i" };
        if (category) filter.category = category;
        if (jobType) filter.jobType = jobType;
        if (location) filter.location = { $regex: location, $options: "i" };
        const jobs = await jobsCollection
          .find(filter)
          .sort({ createdAt: -1 })
          .toArray();
        res.send(jobs);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    // GET /jobs/recruiter — Recruiter এর নিজের সব job
    app.get("/jobs/recruiter", async (req, res) => {
      try {
        const jobs = await jobsCollection
          .find({ recruiterEmail: req.query.email })
          .sort({ createdAt: -1 })
          .toArray();
        res.send(jobs);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    // GET /jobs/:id — single job details
    app.get("/jobs/:id", async (req, res) => {
      try {
        const job = await jobsCollection.findOne({ _id: new ObjectId(req.params.id) });
        if (!job) return res.status(404).send({ message: "Job not found" });
        res.send(job);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    // GET /jobs/company/:companyId — company এর সব active job
    app.get("/jobs/company/:companyId", async (req, res) => {
      try {
        const jobs = await jobsCollection
          .find({ companyId: req.params.companyId, status: "active" })
          .sort({ createdAt: -1 })
          .toArray();
        res.send(jobs);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    // PUT /jobs/:id — job edit
    app.put("/jobs/:id", async (req, res) => {
      try {
        const updatedData = req.body;
        delete updatedData._id;
        const result = await jobsCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: updatedData }
        );
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    // PATCH /jobs/:id/status — Active/Closed toggle
    app.patch("/jobs/:id/status", async (req, res) => {
      try {
        const result = await jobsCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { status: req.body.status } }
        );
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    // DELETE /jobs/:id — job delete
    app.delete("/jobs/:id", async (req, res) => {
      try {
        const result = await jobsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });


    // ════════════════════════════════════════════
    // APPLICATIONS ROUTES
    // ════════════════════════════════════════════

    // POST /applications — Seeker apply (plan limit check সহ)
    app.post("/applications", async (req, res) => {
      try {
        const application = req.body;

        // ── Plan restriction check ──
        const user = await usersCollection.findOne({ email: application.applicantEmail });
        const plan = user?.plan || "free";
        const limit = plan === "premium" ? 999 : plan === "pro" ? 30 : 3;

        const now = new Date();
        const lastReset = user?.lastApplyReset ? new Date(user.lastApplyReset) : null;
        const shouldReset =
          !lastReset ||
          lastReset.getMonth() !== now.getMonth() ||
          lastReset.getFullYear() !== now.getFullYear();

        const usedCount = shouldReset ? 0 : (user?.appliedThisMonth || 0);

        if (usedCount >= limit) {
          return res.status(403).send({
            message: "Apply limit reached. Upgrade your plan to apply more.",
            limitReached: true,
            plan,
            limit,
            used: usedCount,
          });
        }

        // ── Duplicate application check ──
        const existing = await applicationsCollection.findOne({
          jobId: application.jobId,
          applicantEmail: application.applicantEmail,
        });
        if (existing) {
          return res.status(400).send({ message: "Already applied to this job." });
        }

        application.status = "Applied";
        application.appliedAt = new Date();
        const result = await applicationsCollection.insertOne(application);

        // Increment job applicant count
        await jobsCollection.updateOne(
          { _id: new ObjectId(application.jobId) },
          { $inc: { applicantsCount: 1 } }
        );

        // Increment monthly apply count
        if (shouldReset) {
          await usersCollection.updateOne(
            { email: application.applicantEmail },
            { $set: { appliedThisMonth: 1, lastApplyReset: now } }
          );
        } else {
          await usersCollection.updateOne(
            { email: application.applicantEmail },
            { $inc: { appliedThisMonth: 1 } }
          );
        }

        res.send(result);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    // GET /jobs/:jobId/applicants — একটা job এর সব applicant
    app.get("/jobs/:jobId/applicants", async (req, res) => {
      try {
        const applicants = await applicationsCollection
          .find({ jobId: req.params.jobId })
          .sort({ appliedAt: -1 })
          .toArray();
        res.send(applicants);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    // GET /applications/my-applications — Seeker এর সব application
    app.get("/applications/my-applications", async (req, res) => {
      try {
        const applications = await applicationsCollection
          .find({ applicantEmail: req.query.email })
          .sort({ appliedAt: -1 })
          .toArray();
        res.send(applications);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    // PUT /applications/:id — application status update (Recruiter করবে)
    app.put("/applications/:id", async (req, res) => {
      try {
        const result = await applicationsCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { status: req.body.status } }
        );
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });


    // ════════════════════════════════════════════
    // RECRUITER STATS ROUTES
    // ════════════════════════════════════════════

    // GET /recruiter/stats
    app.get("/recruiter/stats", async (req, res) => {
      try {
        const email = req.query.email;
        const totalJobPosts = await jobsCollection.countDocuments({ recruiterEmail: email });
        const activeJobs = await jobsCollection.countDocuments({ recruiterEmail: email, status: "active" });
        const jobsClosed = await jobsCollection.countDocuments({ recruiterEmail: email, status: "closed" });
        const myJobs = await jobsCollection.find({ recruiterEmail: email }).toArray();
        const myJobIds = myJobs.map((j) => j._id.toString());
        const totalApplicants = await applicationsCollection.countDocuments({ jobId: { $in: myJobIds } });
        res.send({ totalJobPosts, totalApplicants, activeJobs, jobsClosed });
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    // GET /recruiter/recent-applications
    app.get("/recruiter/recent-applications", async (req, res) => {
      try {
        const email = req.query.email;
        const myJobs = await jobsCollection.find({ recruiterEmail: email }).toArray();
        const myJobIds = myJobs.map((j) => j._id.toString());
        const applications = await applicationsCollection
          .find({ jobId: { $in: myJobIds } })
          .sort({ appliedAt: -1 })
          .limit(100)
          .toArray();
        res.send(applications);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });


    // ════════════════════════════════════════════
    // USER PLAN ROUTES
    // ════════════════════════════════════════════

    // GET /user/plan
    app.get("/user/plan", async (req, res) => {
      try {
        const user = await usersCollection.findOne({ email: req.query.email });
        if (!user) return res.status(404).send({ message: "User not found" });
        res.send({
          plan: user.plan || "free",
          appliedThisMonth: user.appliedThisMonth || 0,
          applyLimit: user.plan === "premium" ? 999 : user.plan === "pro" ? 30 : 3,
          stripeCustomerId: user.stripeCustomerId || null,
          subscriptionId: user.subscriptionId || null,
        });
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    // PATCH /user/plan
    app.patch("/user/plan", async (req, res) => {
      try {
        const { email, plan, stripeCustomerId, subscriptionId } = req.body;
        const result = await usersCollection.updateOne(
          { email },
          {
            $set: {
              plan,
              stripeCustomerId: stripeCustomerId || null,
              subscriptionId: subscriptionId || null,
              planUpdatedAt: new Date(),
            },
          }
        );
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    // POST /user/increment-apply (legacy — এখন /applications এ handle হয়)
    app.post("/user/increment-apply", async (req, res) => {
      try {
        const { email } = req.body;
        const user = await usersCollection.findOne({ email });
        const now = new Date();
        const lastReset = user?.lastApplyReset ? new Date(user.lastApplyReset) : null;
        const shouldReset =
          !lastReset ||
          lastReset.getMonth() !== now.getMonth() ||
          lastReset.getFullYear() !== now.getFullYear();
        if (shouldReset) {
          await usersCollection.updateOne({ email }, { $set: { appliedThisMonth: 1, lastApplyReset: now } });
        } else {
          await usersCollection.updateOne({ email }, { $inc: { appliedThisMonth: 1 } });
        }
        res.send({ success: true });
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });


    // ════════════════════════════════════════════
    // SAVED JOBS ROUTES
    // ════════════════════════════════════════════

    // GET /saved-jobs
    app.get("/saved-jobs", async (req, res) => {
      try {
        const saved = await savedJobsCollection
          .find({ seekerEmail: req.query.email })
          .sort({ savedAt: -1 })
          .toArray();
        res.send(saved);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    // POST /saved-jobs
    app.post("/saved-jobs", async (req, res) => {
      try {
        const { seekerEmail, jobId, jobTitle, companyName, companyLogo, location, jobType, salary } = req.body;
        const existing = await savedJobsCollection.findOne({ seekerEmail, jobId });
        if (existing) return res.status(400).send({ message: "Already saved" });
        const result = await savedJobsCollection.insertOne({
          seekerEmail, jobId, jobTitle, companyName,
          companyLogo, location, jobType, salary,
          savedAt: new Date(),
        });
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    // DELETE /saved-jobs/:jobId
    app.delete("/saved-jobs/:jobId", async (req, res) => {
      try {
        const result = await savedJobsCollection.deleteOne({
          seekerEmail: req.query.email,
          jobId: req.params.jobId,
        });
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });


    // ════════════════════════════════════════════
    // SEEKER STATS ROUTE
    // ════════════════════════════════════════════

    // GET /seeker/stats
    app.get("/seeker/stats", async (req, res) => {
      try {
        const email = req.query.email;
        const user = await usersCollection.findOne({ email });
        const totalApplications = await applicationsCollection.countDocuments({ applicantEmail: email });
        const activeApplications = await applicationsCollection.countDocuments({
          applicantEmail: email,
          status: { $in: ["Applied", "Under Review"] },
        });
        const shortlisted = await applicationsCollection.countDocuments({ applicantEmail: email, status: "Shortlisted" });
        const savedCount = await savedJobsCollection.countDocuments({ seekerEmail: email });
        res.send({
          totalApplications,
          activeApplications,
          shortlisted,
          savedJobs: savedCount,
          plan: user?.plan || "free",
          appliedThisMonth: user?.appliedThisMonth || 0,
          applyLimit: user?.plan === "premium" ? 999 : user?.plan === "pro" ? 30 : 3,
        });
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });


    // ════════════════════════════════════════════
    // STRIPE ROUTES
    // ════════════════════════════════════════════

    // POST /create-checkout-session
    app.post("/create-checkout-session", async (req, res) => {
      try {
        const { email, plan } = req.body;

        const priceId =
          plan === "premium"
            ? process.env.STRIPE_PREMIUM_PRICE_ID
            : process.env.STRIPE_PRO_PRICE_ID;

        if (!priceId) {
          return res.status(400).send({ message: "Invalid plan or price ID not configured." });
        }

        const session = await stripe.checkout.sessions.create({
          mode: "subscription",
          payment_method_types: ["card"],
          customer_email: email,
          line_items: [{ price: priceId, quantity: 1 }],
          metadata: { email, plan },
          success_url: `${process.env.CLIENT_URL}/payment/success?plan=${plan}`,
          cancel_url: `${process.env.CLIENT_URL}/pricing`,
        });

        res.send({ url: session.url });
      } catch (err) {
        console.error("Stripe checkout error:", err.message);
        res.status(500).send({ message: err.message });
      }
    });

    // POST /cancel-subscription
    app.post("/cancel-subscription", async (req, res) => {
      try {
        const { email } = req.body;
        const user = await usersCollection.findOne({ email });
        if (!user?.subscriptionId) {
          return res.status(400).send({ message: "No active subscription found." });
        }
        await stripe.subscriptions.cancel(user.subscriptionId);
        await usersCollection.updateOne(
          { email },
          { $set: { plan: "free", subscriptionId: null, planUpdatedAt: new Date() } }
        );
        res.send({ success: true });
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });


    // ════════════════════════════════════════════
    // ADMIN ROUTES
    // ════════════════════════════════════════════

    // GET /admin/stats
    app.get("/admin/stats", async (req, res) => {
      try {
        const totalUsers = await usersCollection.countDocuments();
        const totalRecruiters = await usersCollection.countDocuments({ role: "Recruiter" });
        const totalSeekers = await usersCollection.countDocuments({ role: "Job Seeker" });
        const totalCompanies = await companiesCollection.countDocuments();
        const pendingCompanies = await companiesCollection.countDocuments({ status: "pending" });
        const approvedCompanies = await companiesCollection.countDocuments({ status: "approved" });
        const totalJobs = await jobsCollection.countDocuments();
        const activeJobs = await jobsCollection.countDocuments({ status: "active" });
        const totalApplications = await applicationsCollection.countDocuments();
        res.send({
          totalUsers, totalRecruiters, totalSeekers,
          totalCompanies, pendingCompanies, approvedCompanies,
          totalJobs, activeJobs, totalApplications,
        });
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    // GET /admin/companies
    app.get("/admin/companies", async (req, res) => {
      try {
        const filter = {};
        if (req.query.status) filter.status = req.query.status;
        const companies = await companiesCollection
          .find(filter)
          .sort({ createdAt: -1 })
          .toArray();
        res.send(companies);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    // PATCH /admin/companies/:id/status — Approve / Reject
    app.patch("/admin/companies/:id/status", async (req, res) => {
      try {
        const result = await companiesCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { status: req.body.status } }
        );
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    // DELETE /admin/companies/:id — permanently delete
    app.delete("/admin/companies/:id", async (req, res) => {
      try {
        const result = await companiesCollection.deleteOne({ _id: new ObjectId(req.params.id) });
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    // GET /admin/jobs
    app.get("/admin/jobs", async (req, res) => {
      try {
        const { search, status, category } = req.query;
        const filter = {};
        if (search) filter.title = { $regex: search, $options: "i" };
        if (status) filter.status = status;
        if (category) filter.category = category;
        const jobs = await jobsCollection
          .find(filter)
          .sort({ createdAt: -1 })
          .toArray();
        res.send(jobs);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    // DELETE /admin/jobs/:id
    app.delete("/admin/jobs/:id", async (req, res) => {
      try {
        const result = await jobsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    // GET /admin/users
    app.get("/admin/users", async (req, res) => {
      try {
        const filter = {};
        if (req.query.search) filter.email = { $regex: req.query.search, $options: "i" };
        if (req.query.role) filter.role = req.query.role;
        const users = await usersCollection
          .find(filter)
          .sort({ createdAt: -1 })
          .toArray();
        res.send(users);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    // PATCH /admin/users/:id/role
    app.patch("/admin/users/:id/role", async (req, res) => {
      try {
        const result = await usersCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { role: req.body.role } }
        );
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    // PATCH /admin/users/:id/status — suspend / activate
    app.patch("/admin/users/:id/status", async (req, res) => {
      try {
        const result = await usersCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { banned: req.body.banned } }
        );
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

  } catch (err) {
    console.error(err);
  }
}

run().catch(console.dir);

app.listen(port, () => {
  console.log(`HireLoop server running on port ${port}`);
});