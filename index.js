
const dns = require("node:dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
dotenv.config();

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const Stripe = require("stripe");

const app = express();
const port = process.env.PORT || 5000;
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

let usersCollection;
let companiesCollection;

const RECRUITER_LIMITS = { free: 3, growth: 10, enterprise: 50 };
const SEEKER_LIMITS = { free: 3, pro: 30, premium: 999 };

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

app.get("/", (req, res) => {
  res.send("HireLoop Server is running!");
});

async function run() {
  // await client.connect();
  await client.db("admin").command({ ping: 1 });

  const db = client.db("hireLoop");
  companiesCollection = db.collection("companies");
  const jobsCollection = db.collection("jobs");
  const applicationsCollection = db.collection("applications");
  const savedJobsCollection = db.collection("savedJobs");
  usersCollection = db.collection("user");

  app.get("/platform/stats", async (req, res) => {
    try {
      const activeJobs = await jobsCollection.countDocuments({ status: "active" });
      const totalCompanies = await companiesCollection.countDocuments({ status: "approved" });
      const totalSeekers = await usersCollection.countDocuments({ role: "Job Seeker" });
      const totalApplications = await applicationsCollection.countDocuments();
      const positiveOutcomes = await applicationsCollection.countDocuments({
        status: { $in: ["Shortlisted", "Offered"] },
      });

      const satisfactionRate =
        totalApplications > 0 ? Math.round((positiveOutcomes / totalApplications) * 100) : 97;

      res.send({ activeJobs, totalCompanies, totalSeekers, satisfactionRate });
    } catch (err) {
      res.status(500).send({ message: err.message });
    }
  });

  app.get("/jobs/featured", async (req, res) => {
    try {
      const jobs = await jobsCollection
        .find({ status: "active" })
        .sort({ createdAt: -1 })
        .limit(6)
        .toArray();
      res.send(jobs);
    } catch (err) {
      res.status(500).send({ message: err.message });
    }
  });

  app.post("/companies", async (req, res) => {
    try {
      const company = req.body;
      company.status = "pending";
      company.plan = company.plan || "free";
      company.createdAt = new Date();
      const result = await companiesCollection.insertOne(company);
      res.send(result);
    } catch (err) {
      res.status(500).send({ message: err.message });
    }
  });

  app.get("/companies", async (req, res) => {
    try {
      const { industry, search } = req.query;
      const filter = { status: "approved" };
      if (industry) filter.industry = industry;
      if (search) filter.name = { $regex: search, $options: "i" };
      const companies = await companiesCollection.find(filter).sort({ createdAt: -1 }).toArray();
      res.send(companies);
    } catch (err) {
      res.status(500).send({ message: err.message });
    }
  });

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

  app.get("/companies/:id", async (req, res) => {
    try {
      const company = await companiesCollection.findOne({ _id: new ObjectId(req.params.id) });
      if (!company) return res.status(404).send({ message: "Company not found" });
      res.send(company);
    } catch (err) {
      res.status(500).send({ message: err.message });
    }
  });

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

  app.post("/jobs", async (req, res) => {
    try {
      const job = req.body;

      const company = await companiesCollection.findOne({ recruiterEmail: job.recruiterEmail });
      if (company) {
        const plan = company.plan || "free";
        const limit = RECRUITER_LIMITS[plan] ?? 3;

        const activeJobsCount = await jobsCollection.countDocuments({
          recruiterEmail: job.recruiterEmail,
          status: "active",
        });

        if (activeJobsCount >= limit) {
          return res.status(403).send({
            message: "Active job post limit reached. Upgrade your plan to post more jobs.",
            limitReached: true,
            plan,
            limit,
            used: activeJobsCount,
          });
        }
      }

      job.status = job.status || "active";
      job.applicantsCount = 0;
      job.createdAt = new Date();
      const result = await jobsCollection.insertOne(job);
      res.send(result);
    } catch (err) {
      res.status(500).send({ message: err.message });
    }
  });

  app.get("/jobs", async (req, res) => {
    try {
      const { search, category, jobType, location } = req.query;
      const filter = { status: "active" };
      if (search) filter.title = { $regex: search, $options: "i" };
      if (category) filter.category = category;
      if (jobType) filter.jobType = jobType;
      if (location) filter.location = { $regex: location, $options: "i" };
      const jobs = await jobsCollection.find(filter).sort({ createdAt: -1 }).toArray();
      res.send(jobs);
    } catch (err) {
      res.status(500).send({ message: err.message });
    }
  });

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

  app.get("/jobs/:id", async (req, res) => {
    try {
      const job = await jobsCollection.findOne({ _id: new ObjectId(req.params.id) });
      if (!job) return res.status(404).send({ message: "Job not found" });
      res.send(job);
    } catch (err) {
      res.status(500).send({ message: err.message });
    }
  });

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

  app.patch("/jobs/:id/status", async (req, res) => {
    try {
      const { status } = req.body;

      if (status === "active") {
        const job = await jobsCollection.findOne({ _id: new ObjectId(req.params.id) });
        const company = await companiesCollection.findOne({ recruiterEmail: job?.recruiterEmail });

        if (company) {
          const plan = company.plan || "free";
          const limit = RECRUITER_LIMITS[plan] ?? 3;

          const activeJobsCount = await jobsCollection.countDocuments({
            recruiterEmail: job.recruiterEmail,
            status: "active",
          });

          if (activeJobsCount >= limit) {
            return res.status(403).send({
              message: "Active job post limit reached. Upgrade your plan to reopen this job.",
              limitReached: true,
              plan,
              limit,
              used: activeJobsCount,
            });
          }
        }
      }

      const result = await jobsCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { status } }
      );
      res.send(result);
    } catch (err) {
      res.status(500).send({ message: err.message });
    }
  });

  app.delete("/jobs/:id", async (req, res) => {
    try {
      const result = await jobsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
      res.send(result);
    } catch (err) {
      res.status(500).send({ message: err.message });
    }
  });

  app.post("/applications", async (req, res) => {
    try {
      const application = req.body;

      const user = await usersCollection.findOne({ email: application.applicantEmail });
      const plan = user?.plan || "free";
      const limit = SEEKER_LIMITS[plan] ?? 3;

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

      await jobsCollection.updateOne(
        { _id: new ObjectId(application.jobId) },
        { $inc: { applicantsCount: 1 } }
      );

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

  app.get("/recruiter/billing", async (req, res) => {
    try {
      const email = req.query.email;
      const company = await companiesCollection.findOne({ recruiterEmail: email });
      const plan = company?.plan || "free";

      const activeJobs = await jobsCollection.countDocuments({
        recruiterEmail: email,
        status: "active",
      });

      res.send({
        plan,
        activeJobs,
        jobLimit: RECRUITER_LIMITS[plan] ?? 3,
        companyId: company?._id || null,
        companyName: company?.name || null,
        stripeCustomerId: company?.stripeCustomerId || null,
        subscriptionId: company?.subscriptionId || null,
        paymentHistory: company?.paymentHistory || [],
      });
    } catch (err) {
      res.status(500).send({ message: err.message });
    }
  });

 app.patch("/recruiter/billing", async (req, res) => {
  try {
    const { email, plan, stripeCustomerId, subscriptionId, payment } = req.body;

    if (!email || !plan) {
      return res.status(400).send({ message: "email and plan are required" });
    }

    const updateDoc = {
      plan,
      stripeCustomerId: stripeCustomerId || null,
      subscriptionId: subscriptionId || null,
      planUpdatedAt: new Date(),
    };

    const updateOps = {
      $set: updateDoc,
      $setOnInsert: {
        recruiterEmail: email,
        createdAt: new Date(),
      },
    };

    if (payment) {
      updateOps.$push = {
        paymentHistory: { ...payment, date: new Date() },
      };
    }

    const result = await companiesCollection.updateOne(
      { recruiterEmail: email },
      updateOps,
      { upsert: true }
    );

    res.send({
      success: true,
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
      upsertedCount: result.upsertedCount || 0,
    });
  } catch (err) {
    res.status(500).send({ message: err.message });
  }
});


  app.post("/create-recruiter-checkout-session", async (req, res) => {
    try {
      const { email, plan } = req.body;

      const priceMap = {
        growth: process.env.STRIPE_RECRUITER_GROWTH_PRICE_ID,
        enterprise: process.env.STRIPE_RECRUITER_ENTERPRISE_PRICE_ID,
      };

      const priceId = priceMap[plan];
      if (!priceId) {
        return res.status(400).send({ message: "Invalid plan or price ID not configured." });
      }

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        payment_method_types: ["card"],
        line_items: [{ price: priceId, quantity: 1 }],
        customer_email: email,
        success_url: `${process.env.CLIENT_URL}/payment/success?plan=${plan}&type=recruiter&email=${encodeURIComponent(email)}`,
        cancel_url: `${process.env.CLIENT_URL}/payment/cancel?plan=${plan}&type=recruiter&email=${encodeURIComponent(email)}`,
        metadata: { email, plan, type: "recruiter" },
        subscription_data: {
          metadata: { email, plan, type: "recruiter" },
        },
      });

      res.send({ url: session.url });
    } catch (err) {
      console.error("Stripe checkout error:", err.message);
      res.status(500).send({ message: err.message });
    }
  });

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
        metadata: { email, plan, type: "seeker" },
        subscription_data: {
          metadata: { email, plan, type: "seeker" },
        },
        success_url: `${process.env.CLIENT_URL}/payment/success?plan=${plan}&type=seeker&email=${encodeURIComponent(email)}`,
        cancel_url: `${process.env.CLIENT_URL}/payment/cancel?plan=${plan}&type=seeker&email=${encodeURIComponent(email)}`,
      });

      res.send({ url: session.url });
    } catch (err) {
      console.error("Stripe checkout error:", err.message);
      res.status(500).send({ message: err.message });
    }
  });

  app.get("/my-plan", async (req, res) => {
    try {
      const { email, role } = req.query;
      if (!email) return res.status(400).send({ message: "email is required" });

      if (role === "Recruiter") {
        const company = await companiesCollection.findOne({ recruiterEmail: email });
        const plan = company?.plan || "free";
        return res.send({
          scope: "recruiter",
          plan,
          limit: RECRUITER_LIMITS[plan] ?? 3,
          subscriptionId: company?.subscriptionId || null,
        });
      }

      const user = await usersCollection.findOne({ email });
      const plan = user?.plan || "free";
      res.send({
        scope: "seeker",
        plan,
        appliedThisMonth: user?.appliedThisMonth || 0,
        limit: SEEKER_LIMITS[plan] ?? 3,
        subscriptionId: user?.subscriptionId || null,
      });
    } catch (err) {
      res.status(500).send({ message: err.message });
    }
  });

  app.get("/user/plan", async (req, res) => {
    try {
      const user = await usersCollection.findOne({ email: req.query.email });
      if (!user) return res.status(404).send({ message: "User not found" });

      res.send({
        plan: user.plan || "free",
        appliedThisMonth: user.appliedThisMonth || 0,
        applyLimit: SEEKER_LIMITS[user.plan] ?? 3,
        stripeCustomerId: user.stripeCustomerId || null,
        subscriptionId: user.subscriptionId || null,
      });
    } catch (err) {
      res.status(500).send({ message: err.message });
    }
  });

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

app.post("/cancel-subscription", async (req, res) => {
  try {
    const { email, role } = req.body;

    if (!email || !role) {
      return res.status(400).send({ message: "email and role are required" });
    }

    if (role === "Recruiter") {
      const result = await companiesCollection.updateOne(
        { recruiterEmail: email },
        {
          $set: {
            plan: "free",
            subscriptionId: null,
            stripeCustomerId: null,
            planUpdatedAt: new Date(),
          },
          $unset: { paymentHistory: "" },
        }
      );

      if (result.matchedCount === 0) {
        return res.status(404).send({ message: "Recruiter company not found" });
      }

      return res.send({ success: true });
    }

    const result = await usersCollection.updateOne(
      { email },
      {
        $set: {
          plan: "free",
          subscriptionId: null,
          stripeCustomerId: null,
          planUpdatedAt: new Date(),
        },
        $unset: {
          appliedThisMonth: "",
          lastApplyReset: "",
        },
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({ message: "User not found" });
    }

    res.send({ success: true });
  } catch (err) {
    res.status(500).send({ message: err.message });
  }
});




  app.get("/payment/verify", async (req, res) => {
    try {
      const { email, role, expectedPlan } = req.query;

      if (role === "Recruiter") {
        const company = await companiesCollection.findOne({ recruiterEmail: email });
        const plan = company?.plan || "free";
        return res.send({
          confirmed: expectedPlan ? plan === expectedPlan : plan !== "free",
          plan,
        });
      }

      const user = await usersCollection.findOne({ email });
      const plan = user?.plan || "free";
      res.send({
        confirmed: expectedPlan ? plan === expectedPlan : plan !== "free",
        plan,
      });
    } catch (err) {
      res.status(500).send({ message: err.message });
    }
  });

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
        applyLimit: SEEKER_LIMITS[user?.plan] ?? 3,
      });
    } catch (err) {
      res.status(500).send({ message: err.message });
    }
  });

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

  app.get("/admin/companies", async (req, res) => {
    try {
      const filter = {};
      if (req.query.status) filter.status = req.query.status;
      const companies = await companiesCollection.find(filter).sort({ createdAt: -1 }).toArray();
      res.send(companies);
    } catch (err) {
      res.status(500).send({ message: err.message });
    }
  });

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

  app.delete("/admin/companies/:id", async (req, res) => {
    try {
      const result = await companiesCollection.deleteOne({ _id: new ObjectId(req.params.id) });
      res.send(result);
    } catch (err) {
      res.status(500).send({ message: err.message });
    }
  });

  app.get("/admin/jobs", async (req, res) => {
    try {
      const { search, status, category } = req.query;
      const filter = {};
      if (search) filter.title = { $regex: search, $options: "i" };
      if (status) filter.status = status;
      if (category) filter.category = category;
      const jobs = await jobsCollection.find(filter).sort({ createdAt: -1 }).toArray();
      res.send(jobs);
    } catch (err) {
      res.status(500).send({ message: err.message });
    }
  });

  app.delete("/admin/jobs/:id", async (req, res) => {
    try {
      const result = await jobsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
      res.send(result);
    } catch (err) {
      res.status(500).send({ message: err.message });
    }
  });

  app.get("/admin/users", async (req, res) => {
    try {
      const filter = {};
      if (req.query.search) filter.email = { $regex: req.query.search, $options: "i" };
      if (req.query.role) filter.role = req.query.role;
      const users = await usersCollection.find(filter).sort({ createdAt: -1 }).toArray();
      res.send(users);
    } catch (err) {
      res.status(500).send({ message: err.message });
    }
  });

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
}

run().catch(console.dir);

app.listen(port, () => {
  console.log(`HireLoop server running on port ${port}`);
});