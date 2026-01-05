import dotenv from "dotenv";
import express from "express";
import bodyParser from "body-parser";
import logger from "morgan"
import dubRouter from "./routes/dub.route";
import cors from "cors";


dotenv.config();


const app = express();

app.use(cors());

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(logger("dev"));

app.use("/dub", dubRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
