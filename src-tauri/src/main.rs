fn main() {
    if let Err(error) = super_md_lib::run() {
        eprintln!("Super MD: {error:#}");
        std::process::exit(1);
    }
}
