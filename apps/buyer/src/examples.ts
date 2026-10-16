// The three example tasks submitted with the project. Each needs all three categories.
export const EXAMPLE_TASKS = [
  {
    id: "books-inr-hindi",
    title: "Cheapest 5-star books in rupees, with Hindi summaries",
    task: "From pages 1 to 4 of books.toscrape.com, find the three cheapest 5-star books, give their prices in rupees, and summarise each description in Hindi.",
    budget: "0.050",
    expectedUsdc: "0.041",
  },
  {
    id: "travel-pitches",
    title: "Priciest Travel books in EUR and JPY, with Hindi pitches",
    task: "In the Travel category of books.toscrape.com, find the 4 most expensive books, give their prices in EUR and JPY, and write a one-line Hindi pitch for each.",
    budget: "0.035",
    expectedUsdc: "0.027",
  },
  {
    id: "genre-guide",
    title: "Mystery vs Historical Fiction prices, with a Hindi buying guide",
    task: "Compare the average price of Mystery and Historical Fiction books on books.toscrape.com in USD, INR and EUR, and write a short Hindi buying guide.",
    budget: "0.040",
    expectedUsdc: "0.033",
  },
] as const;
